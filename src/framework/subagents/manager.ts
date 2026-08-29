import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { AgentToolUpdateCallback, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { PythonToolDefinition, ResolvedAgentProfile, ResolvedConfig, RunSummary } from "../types.ts";
import type { ChildEvent, ChildRequest } from "./protocol.ts";

type AgentOverride = { model?: string; thinking?: ThinkingLevel };

export type RunOptions = {
  profile: ResolvedAgentProfile;
  task: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  override?: AgentOverride;
};

export type RunResult = { text: string; value?: unknown; runId: string };

const CHILD_RUNNER = fileURLToPath(new URL("./child-runner.ts", import.meta.url));

export class SubagentManager {
  private readonly runs = new Map<string, RunSummary>();
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
    return [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async run(options: RunOptions): Promise<RunResult> {
    const runId = randomUUID();
    const summary: RunSummary = {
      id: runId,
      agent: options.profile.id,
      state: "starting",
      startedAt: new Date().toISOString(),
    };
    this.runs.set(runId, summary);
    const runDirectory = path.join(this.config.cwd, this.config.dataDirectory, "runs", runId);
    await mkdir(runDirectory, { recursive: true });
    await this.saveSummary(runDirectory, summary);

    const tools = (options.profile.tools ?? [])
      .filter((name) => name !== "delegate_agent")
      .map((name) => {
        const definition = this.toolDefinitions.get(name);
        if (!definition) throw new Error(`Subagent '${options.profile.id}' references unknown tool '${name}'.`);
        return definition;
      });
    const request: ChildRequest = {
      runId,
      task: options.task,
      profile: options.profile,
      model: options.override?.model ?? options.profile.model?.id ?? this.config.defaultModel,
      thinking: options.override?.thinking ?? options.profile.thinking ?? this.config.defaultThinking,
      python: this.config.python,
      tools,
    };

    const attempts = Math.max(1, (options.profile.maxRetries ?? 0) + 1);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.runAttempt(request, runDirectory, summary, attempt, options.signal, options.onUpdate);
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted || attempt === attempts) break;
        await this.appendEvent(runDirectory, { type: "retry", attempt: attempt + 1 });
      }
    }
    summary.state = options.signal?.aborted ? "aborted" : "failed";
    summary.endedAt = new Date().toISOString();
    summary.error = lastError instanceof Error ? lastError.message : String(lastError);
    await this.saveSummary(runDirectory, summary);
    throw lastError;
  }

  private async runAttempt(
    request: ChildRequest,
    runDirectory: string,
    summary: RunSummary,
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
          void this.appendEvent(runDirectory, { attempt, ...event, messages: undefined });
          if (event.type === "status") {
            summary.state = event.state;
            onUpdate?.({ content: [{ type: "text", text: event.message }], details: { runId: request.runId, state: event.state } });
          } else if (event.type === "text_delta") {
            onUpdate?.({ content: [{ type: "text", text: `${request.profile.id}: working…` }], details: { runId: request.runId, state: "running", recent: event.delta } });
          } else if (event.type === "tool_start") {
            onUpdate?.({ content: [{ type: "text", text: `${request.profile.id}: running ${event.name}` }], details: { runId: request.runId, state: "running", tool: event.name } });
          } else if (event.type === "result") {
            finalResult = event;
          } else if (event.type === "error") {
            childError = event.message;
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
      finalResult.messages.map((message) => JSON.stringify({ type: "message", message })).join("\n") + "\n",
      "utf8",
    );
    await writeFile(path.join(runDirectory, "output.md"), finalResult.text, "utf8");
    summary.state = "completed";
    summary.endedAt = new Date().toISOString();
    await this.saveSummary(runDirectory, summary);
    return { text: finalResult.text, value: finalResult.value, runId: request.runId };
  }

  private async appendEvent(runDirectory: string, event: unknown): Promise<void> {
    await appendFile(path.join(runDirectory, "events.jsonl"), `${JSON.stringify({ timestamp: new Date().toISOString(), ...event as object })}\n`, "utf8");
  }

  private async saveSummary(runDirectory: string, summary: RunSummary): Promise<void> {
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
