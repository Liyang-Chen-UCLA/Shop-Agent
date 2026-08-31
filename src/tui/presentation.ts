import type { ProductTask, RunDetail, RunEvent, RunSummary, TaskState } from "../framework/types.ts";

const SECRET_FIELD = /(?:key|token|secret|password|authorization)/i;
const CARD_EVENT_LIMIT = 8;

function redactValue(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (SECRET_FIELD.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return redactValue(JSON.parse(trimmed), key, seen);
      } catch {
        return value;
      }
    }
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, "", seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
    childKey,
    redactValue(child, childKey, seen),
  ]));
}

function stringify(value: unknown, pretty = false): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(redactValue(value), null, pretty ? 2 : undefined) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function inline(value: unknown, maxLength = 160): string {
  return `\`${truncate(stringify(value), maxLength).replace(/`/g, "ˋ") || "—"}\``;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+.!|>-])/g, "\\$1");
}

function elapsed(startedAt: string, endedAt?: string): string {
  const milliseconds = Math.max(0, Date.parse(endedAt ?? new Date().toISOString()) - Date.parse(startedAt));
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
}

function stateIcon(state: RunSummary["state"]): string {
  if (state === "completed") return "✓";
  if (state === "failed" || state === "aborted") return "✗";
  return "◇";
}

function eventLine(event: RunEvent): string {
  if (event.type === "tool_start") return `◇ ${inline(event.tool)} args ${inline(event.args)}`;
  if (event.type === "tool_end") return `${event.isError ? "✗" : "✓"} ${inline(event.tool)} → ${inline(event.result)}`;
  if (event.type === "retry") return `↻ ${escapeMarkdown(event.message ?? `Retry attempt ${event.attempt}`)}`;
  if (event.type === "error") return `✗ ${escapeMarkdown(event.message ?? "Subagent failed")}`;
  if (event.type === "result") return "✓ Subagent completed";
  return `◇ ${escapeMarkdown(event.message ?? event.type)}`;
}

export function summarizeValue(value: unknown, maxLength = 160): string {
  return truncate(stringify(value), maxLength);
}

export function renderRunCard(run: RunSummary & { events: RunEvent[] }): string {
  const relevant = run.events.filter((event) => event.type !== "status" || event.state === "starting");
  const hidden = Math.max(0, relevant.length - CARD_EVENT_LIMIT);
  const visible = relevant.slice(-CARD_EVENT_LIMIT);
  const chain = [
    ...(hidden ? [`… ${hidden} earlier event${hidden === 1 ? "" : "s"}`] : []),
    ...visible.map(eventLine),
  ];
  return [
    `> ${stateIcon(run.state)} **Subagent · ${escapeMarkdown(run.agent)}** · \`${run.state}\` · ${elapsed(run.startedAt, run.endedAt)}`,
    `> Task: ${inline(run.task)}`,
    ...chain.map((line, index) => `> ${index === chain.length - 1 ? "└" : "├"} ${line}`),
    run.id ? `> Run: \`${run.id.slice(0, 8)}\`` : "",
  ].filter(Boolean).join("\n");
}

function eventDetail(event: RunEvent): string[] {
  const time = new Date(event.timestamp).toLocaleTimeString();
  if (event.type === "tool_start") {
    return [`- **${time} · ${event.tool} started**`, "", "```json", stringify(event.args, true), "```"];
  }
  if (event.type === "tool_end") {
    return [`- **${time} · ${event.tool} ${event.isError ? "failed" : "completed"}**`, "", "```json", stringify(event.result, true), "```"];
  }
  return [`- **${time} · ${event.type}** — ${escapeMarkdown(event.message ?? event.state ?? "")}`];
}

export function renderRunDetail(run: RunDetail): string {
  return [
    `## Subagent run ${inline(run.id.slice(0, 8))}`,
    "",
    `- Agent: **${escapeMarkdown(run.agent)}**`,
    `- State: ${inline(run.state)}`,
    `- Model: ${inline(run.model)}`,
    `- Thinking: ${inline(run.thinking)}`,
    `- Started: ${inline(run.startedAt)}`,
    `- Duration: ${inline(elapsed(run.startedAt, run.endedAt))}`,
    "",
    "### Delegated task",
    "",
    escapeMarkdown(run.task),
    "",
    "### Execution timeline",
    "",
    ...run.events.flatMap(eventDetail),
    "",
    "### Final output",
    "",
    run.output?.trim() || (run.error ? `Error: ${escapeMarkdown(run.error)}` : "No final output yet."),
  ].join("\n");
}

function renderTask(task: ProductTask, activeTaskId: string | null): string {
  const active = task.task_id === activeTaskId ? " · **active**" : "";
  const preferences = Object.entries(task.preference);
  return [
    `### ${escapeMarkdown(task.product)}${active}`,
    "",
    `- Task ID: ${inline(task.task_id.slice(0, 8))}`,
    `- Taxonomy: ${escapeMarkdown(task.route.node_path)} (${inline(task.route.node_id)})`,
    `- Preferences: ${preferences.length ? "" : "none"}`,
    ...preferences.map(([key, value]) => `  - ${escapeMarkdown(key)}: ${inline(value)}`),
  ].join("\n");
}

export function renderTaskState(state: TaskState, all: boolean): string {
  if (!state.tasks.length) return "## Tasks\n\nNo product-analysis tasks in this session.";
  const active = state.tasks.find((task) => task.task_id === state.active_task_id);
  const tasks = all ? state.tasks : active ? [active] : [];
  if (!tasks.length) return "## Active task\n\nThis session has tasks, but no active task is selected.";
  return [all ? "## All tasks" : "## Active task", "", ...tasks.flatMap((task, index) => [
    ...(index ? ["", "---", ""] : []),
    renderTask(task, state.active_task_id),
  ])].join("\n");
}
