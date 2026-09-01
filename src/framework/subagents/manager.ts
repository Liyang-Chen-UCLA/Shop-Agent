import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { AgentToolUpdateCallback, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  PythonToolDefinition,
  ResolvedAgentProfile,
  ResolvedConfig,
  RunDetail,
  RunEvent,
  RunSummary,
  SubagentUpdateDetails,
} from "../types.ts";
import { DEVELOPER_ISSUE_TOOL, isNativeToolName, WEB_SEARCH_TOOL } from "../native-tools.ts";
import { sanitizeDeveloperDiagnosticMessages } from "../content.ts";
import type { ChildEvent, ChildRequest } from "./protocol.ts";

type AgentOverride = { model?: string; thinking?: ThinkingLevel };

export type RunOptions = {
  profile: ResolvedAgentProfile;
  task: string;
  sessionId?: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  override?: AgentOverride;
};

export type RunResult = { text: string; value?: unknown; runId: string };

const CHILD_RUNNER = fileURLToPath(new URL("./child-runner.ts", import.meta.url));

export class SubagentManager {
  private readonly runs = new Map<string, RunDetail>();
  private readonly config: ResolvedConfig;
  private readonly toolDefinitions: Map<string, PythonToolDefinition>;

  constructor(
    config: ResolvedConfig,
    toolDefinitions: Map<string, PythonToolDefinition>,
  ) {
    this.config = config;
    this.toolDefinitions = toolDefinitions;
  }

  listRuns(): RunSummary[] {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(({ events: _events, output: _output, value: _value, model: _model, thinking: _thinking, ...summary }) => ({ ...summary }));
  }

  getRun(idOrPrefix: string): RunDetail {
    const matches = [...this.runs.values()].filter((run) => run.id === idOrPrefix || run.id.startsWith(idOrPrefix));
    if (matches.length === 0) throw new Error(`Unknown subagent run: ${idOrPrefix}`);
    if (matches.length > 1) throw new Error(`Ambiguous subagent run prefix: ${idOrPrefix}`);
    const run = matches[0];
    return { ...run, events: run.events.map((event) => ({ ...event })) };
  }

  async run(options: RunOptions): Promise<RunResult> {
    const runId = randomUUID();
    const detail: RunDetail = {
      id: runId,
      agent: options.profile.id,
      task: options.task,
      state: "starting",
      startedAt: new Date().toISOString(),
      model: options.override?.model ?? options.profile.model?.id ?? this.config.defaultModel,
      thinking: options.override?.thinking ?? options.profile.thinking ?? this.config.defaultThinking,
      events: [],
    };
    this.runs.set(runId, detail);
    const runDirectory = path.join(this.config.cwd, this.config.dataDirectory, "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    await this.saveSummary(runDirectory, detail);

    const tools = (options.profile.tools ?? [])
      .filter((name) => name !== "delegate_agent" && !isNativeToolName(name))
      .map((name) => {
        const definition = this.toolDefinitions.get(name);
        if (!definition) throw new Error(`Subagent '${options.profile.id}' references unknown tool '${name}'.`);
        return definition;
      });
    const request: ChildRequest = {
      runId,
      sessionId: options.sessionId ?? runId,
      projectRoot: this.config.cwd,
      task: options.task,
      profile: options.profile,
      model: detail.model,
      thinking: detail.thinking,
      python: this.config.python,
      tools,
    };

    const attempts = Math.max(1, (options.profile.maxRetries ?? 0) + 1);
    let lastError: unknown;
    let lastAttempt = 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      lastAttempt = attempt;
      try {
        return await this.runAttempt(request, runDirectory, detail, attempt, options.signal, options.onUpdate);
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted || attempt === attempts) break;
        this.recordEvent(detail, runDirectory, {
          timestamp: new Date().toISOString(),
          attempt: attempt + 1,
          type: "retry",
          message: `Retrying ${options.profile.id} (attempt ${attempt + 1})`,
        }, options.onUpdate);
      }
    }
    detail.state = options.signal?.aborted ? "aborted" : "failed";
    detail.endedAt = new Date().toISOString();
    detail.error = lastError instanceof Error ? lastError.message : String(lastError);
    this.recordEvent(detail, runDirectory, {
      timestamp: detail.endedAt,
      attempt: lastAttempt,
      type: "error",
      state: detail.state,
      message: detail.error,
    }, options.onUpdate);
    await this.saveSummary(runDirectory, detail);
    throw lastError;
  }

  private async runAttempt(
    request: ChildRequest,
    runDirectory: string,
    detail: RunDetail,
    attempt: number,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<RunResult> {
    const child = spawn(process.execPath, [CHILD_RUNNER], {
      cwd: this.config.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.end(JSON.stringify(request));
    let buffer = "";
    let stderr = "";
    let finalResult: Extract<ChildEvent, { type: "result" }> | undefined;
    let childError: string | undefined;
    let timedOut = false;
    let reportedReasoning = false;
    let reportedWriting = false;

    const abort = () => this.terminate(child);
    const timeout = setTimeout(() => {
      timedOut = true;
      this.terminate(child);
    }, request.profile.timeoutMs ?? 120_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as ChildEvent;
          if (event.type === "status") {
            detail.state = event.state;
            this.recordEvent(detail, runDirectory, {
              timestamp: new Date().toISOString(), attempt, type: "status", state: event.state, message: event.message,
            }, onUpdate);
          } else if (event.type === "thinking_delta" && !reportedReasoning) {
            reportedReasoning = true;
            this.recordEvent(detail, runDirectory, {
              timestamp: new Date().toISOString(), attempt, type: "reasoning", state: "running", message: "Analyzing task",
            }, onUpdate);
          } else if (event.type === "text_delta") {
            if (!reportedWriting) {
              reportedWriting = true;
              this.recordEvent(detail, runDirectory, {
                timestamp: new Date().toISOString(), attempt, type: "writing", state: "running", message: "Writing response",
              }, onUpdate);
            }
          } else if (event.type === "tool_start") {
            if (event.name === DEVELOPER_ISSUE_TOOL) continue;
            this.recordEvent(detail, runDirectory, {
              timestamp: new Date().toISOString(), attempt, type: "tool_start", state: "running", tool: event.name, args: event.args,
            }, onUpdate);
          } else if (event.type === "tool_end") {
            if (event.name === DEVELOPER_ISSUE_TOOL) continue;
            const result = event.name === WEB_SEARCH_TOOL
              ? (event.isError ? "web_search failed" : "web_search completed")
              : event.result;
            this.recordEvent(detail, runDirectory, {
              timestamp: new Date().toISOString(), attempt, type: "tool_end", state: "running", tool: event.name,
              result, isError: event.isError,
            }, onUpdate);
          } else if (event.type === "result") {
            finalResult = event;
          } else if (event.type === "error") {
            childError = event.message;
            this.recordEvent(detail, runDirectory, {
              timestamp: new Date().toISOString(), attempt, type: "error", message: `Attempt ${attempt} failed: ${event.message}`,
            }, onUpdate);
          }
        } catch (error) {
          childError = `Invalid child event: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    });

    if (signal?.aborted) throw new Error(`Subagent '${request.profile.id}' was aborted.`);
    if (timedOut) throw new Error(`Subagent '${request.profile.id}' timed out after ${request.profile.timeoutMs ?? 120_000}ms.`);
    if (exitCode !== 0 || childError || !finalResult) {
      throw new Error(childError ?? stderr.trim() ?? `Subagent exited with code ${exitCode}.`);
    }

    await writeFile(
      path.join(runDirectory, "transcript.jsonl"),
      sanitizeDeveloperDiagnosticMessages(finalResult.messages)
        .map((message) => JSON.stringify({ type: "message", message })).join("\n") + "\n",
      "utf8",
    );
    await writeFile(path.join(runDirectory, "output.md"), finalResult.text, "utf8");
    detail.state = "completed";
    detail.endedAt = new Date().toISOString();
    detail.output = finalResult.text;
    detail.value = finalResult.value;
    this.recordEvent(detail, runDirectory, {
      timestamp: detail.endedAt, attempt, type: "result", state: "completed", message: "Subagent completed",
    }, onUpdate);
    await this.saveSummary(runDirectory, detail);
    return { text: finalResult.text, value: finalResult.value, runId: request.runId };
  }

  private recordEvent(
    detail: RunDetail,
    runDirectory: string,
    event: RunEvent,
    onUpdate?: AgentToolUpdateCallback,
  ): void {
    detail.events.push(event);
    void this.appendEvent(runDirectory, event);
    const details: SubagentUpdateDetails = {
      kind: "subagent",
      runId: detail.id,
      agent: detail.agent,
      task: detail.task,
      event,
    };
    onUpdate?.({ content: [{ type: "text", text: event.message ?? `${detail.agent}: ${event.type}` }], details });
  }

  private async appendEvent(runDirectory: string, event: unknown): Promise<void> {
    await appendFile(path.join(runDirectory, "events.jsonl"), `${JSON.stringify({ timestamp: new Date().toISOString(), ...event as object })}\n`, "utf8");
  }

  private async saveSummary(runDirectory: string, detail: RunDetail): Promise<void> {
    const { events: _events, output: _output, value: _value, model: _model, thinking: _thinking, ...summary } = detail;
    await writeFile(path.join(runDirectory, "status.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  private terminate(child: ChildProcessWithoutNullStreams): void {
    if (child.killed || child.exitCode !== null) return;
    child.kill();
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.unref();
    }
  }
}
