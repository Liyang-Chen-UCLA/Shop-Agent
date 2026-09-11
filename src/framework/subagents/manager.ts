import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { resolveAgentLlm, resolveSubagentTimeout } from "../config.ts";
import type {
  PythonToolDefinition,
  ResolvedAgentProfile,
  ResolvedConfig,
  RunDetail,
  RunEvent,
  RunSummary,
  RuntimeLlmOverride,
  SubagentUpdateDetails,
} from "../types.ts";
import type { PythonExecutor } from "../python-executor.ts";
import { DEVELOPER_ISSUE_TOOL, isNativeToolName, WEB_SEARCH_TOOL } from "../native-tools.ts";
import { sanitizeDeveloperDiagnosticMessages } from "../content.ts";
import { emptyContractState, isContractStateToolName, validateContractState, type ContractState } from "../contract-state.ts";
import type { ChildEvent, ChildRequest, SubagentCheckpoint } from "./protocol.ts";
import { NoopTracing, type TraceObservation, type Tracing } from "../tracing/index.ts";

type AgentOverride = RuntimeLlmOverride;

export type RunOptions = {
  profile: ResolvedAgentProfile;
  task: string;
  sessionId?: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
  override?: AgentOverride;
  /** Optional full session override map used by internally chained stages. */
  overrides?: Record<string, AgentOverride>;
};

export type RunResult = { text: string; value?: unknown; runId: string };

export type RecoverySummary = {
  taskId: string;
  status: "interrupted";
  reason: string;
  last_completed_activity: string;
  current_activity: string;
  resumable: boolean;
};

export type SubagentTaskResult =
  | { taskId: string; status: "completed"; result: unknown }
  | RecoverySummary
  | { taskId: string; status: "cancelled" };

type ManagedTask = {
  detail: RunDetail;
  sessionId: string;
  requestedAgent: string;
  override?: AgentOverride;
  overrides?: Record<string, AgentOverride>;
  checkpoint?: SubagentCheckpoint;
  currentActivity: string;
  lastCompletedActivity: string;
};

type ManagedRunOptions = RunOptions & { managed?: ManagedTask };

const CHILD_RUNNER = fileURLToPath(new URL("./child-runner.ts", import.meta.url));

export class SubagentManager {
  private readonly runs = new Map<string, RunDetail>();
  private readonly tasks = new Map<string, ManagedTask>();
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private readonly config: ResolvedConfig;
  private readonly toolDefinitions: Map<string, PythonToolDefinition>;
  private readonly python?: PythonExecutor;
  private readonly tracing: Tracing;
  private readonly contractStates = new Map<string, ContractState>();

  constructor(
    config: ResolvedConfig,
    toolDefinitions: Map<string, PythonToolDefinition>,
    python?: PythonExecutor,
    tracing: Tracing = new NoopTracing(),
  ) {
    this.config = config;
    this.toolDefinitions = toolDefinitions;
    this.python = python;
    this.tracing = tracing;
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

  async run(options: ManagedRunOptions): Promise<RunResult> {
    if (options.profile.id === "research_agent") {
      return this.runCriteriaAndMarket(options);
    }
    return this.runSingle(options);
  }

  private async runSingle(options: ManagedRunOptions): Promise<RunResult> {
    const name = options.profile.id.replaceAll("_", "-");
    return this.tracing.withObservation(name, "agent", {
      input: options.managed && options.managed.detail.execution > 1
        ? { resumed: true, lastCompletedActivity: options.managed.lastCompletedActivity }
        : options.task,
      metadata: {
        taskId: options.managed?.detail.id,
        subagentType: options.profile.id,
        executionId: options.managed?.detail.executionId,
        execution: options.managed?.detail.execution,
        status: "running",
      },
    }, async (observation) => {
      const result = await this.runSingleObserved(options, observation);
      if (options.profile.contractState) {
        const sessionId = options.sessionId ?? result.runId;
        const state = validateContractState(options.profile.contractState, result.value);
        this.contractStates.set(this.contractStateKey(sessionId, options.task), state);
      }
      return result;
    });
  }

  async delegate(options: RunOptions): Promise<SubagentTaskResult> {
    const taskId = randomUUID();
    const detail: RunDetail = {
      id: taskId,
      agent: options.profile.id,
      task: options.task,
      state: "running",
      startedAt: new Date().toISOString(),
      execution: 0,
      stageAgent: options.profile.id,
      model: "",
      thinking: "off",
      events: [],
    };
    const task: ManagedTask = {
      detail,
      sessionId: options.sessionId ?? taskId,
      requestedAgent: options.profile.id,
      override: options.override,
      overrides: options.overrides,
      currentActivity: "Starting subagent",
      lastCompletedActivity: "Task initialized",
    };
    this.tasks.set(taskId, task);
    this.runs.set(taskId, detail);
    await mkdir(this.runDirectory(taskId), { recursive: true });
    await this.saveTask(task);
    return this.executeManaged(task, options.signal, options.onUpdate);
  }

  async resume(taskId: string, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback): Promise<SubagentTaskResult> {
    const task = await this.loadTask(taskId);
    if (task.detail.state === "completed") throw new Error(`Subagent task '${taskId}' is completed and cannot be resumed.`);
    if (task.detail.state === "cancelled") throw new Error(`Subagent task '${taskId}' is cancelled and cannot be resumed.`);
    if (task.detail.state !== "interrupted") throw new Error(`Subagent task '${taskId}' is ${task.detail.state} and cannot be resumed.`);
    if (!task.detail.resumable) throw new Error(`Subagent task '${taskId}' is not resumable.`);
    this.recordEvent(task.detail, this.runDirectory(taskId), {
      timestamp: new Date().toISOString(), execution: task.detail.execution + 1, type: "resume", state: "running", message: "Resuming interrupted subagent task",
    }, onUpdate);
    return this.executeManaged(task, signal, onUpdate);
  }

  async cancel(taskId: string, onUpdate?: AgentToolUpdateCallback): Promise<SubagentTaskResult> {
    const task = await this.loadTask(taskId);
    if (task.detail.state === "completed") throw new Error(`Subagent task '${taskId}' is completed and cannot be cancelled.`);
    if (task.detail.state === "cancelled") return { taskId, status: "cancelled" };
    if (task.detail.state === "running") throw new Error(`Subagent task '${taskId}' is running and cannot be cancelled from the serial orchestrator.`);
    task.detail.state = "cancelled";
    task.detail.resumable = false;
    task.detail.reason = undefined;
    task.detail.endedAt = new Date().toISOString();
    this.recordEvent(task.detail, this.runDirectory(taskId), {
      timestamp: task.detail.endedAt, execution: task.detail.execution, type: "cancel", state: "cancelled", message: "Subagent task cancelled",
    }, onUpdate);
    await this.saveTask(task);
    await this.tracing.withObservation("cancel-subagent", "span", {
      input: { taskId }, output: { status: "cancelled" },
      metadata: { taskId, subagentType: task.detail.stageAgent ?? task.requestedAgent, execution: task.detail.execution, status: "cancelled" },
    }, async () => undefined, task.sessionId);
    return { taskId, status: "cancelled" };
  }

  private async executeManaged(task: ManagedTask, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback): Promise<SubagentTaskResult> {
    const profile = this.config.agents.find((item) => item.id === task.requestedAgent);
    if (!profile) throw new Error(`Subagent task '${task.detail.id}' references unknown agent '${task.requestedAgent}'.`);
    task.detail.execution += 1;
    task.detail.executionId = randomUUID();
    task.detail.state = "running";
    task.detail.endedAt = undefined;
    task.detail.error = undefined;
    task.detail.reason = undefined;
    task.detail.resumable = undefined;
    await this.saveTask(task);
    try {
      const result = await this.run({
        profile,
        task: task.detail.task,
        sessionId: task.sessionId,
        signal,
        onUpdate,
        override: task.override,
        overrides: task.overrides,
        managed: task,
      } as ManagedRunOptions);
      task.detail.state = "completed";
      task.detail.endedAt = new Date().toISOString();
      task.detail.output = result.text;
      task.detail.value = result.value;
      task.detail.resumable = false;
      this.recordEvent(task.detail, this.runDirectory(task.detail.id), {
        timestamp: task.detail.endedAt, execution: task.detail.execution, type: "result", state: "completed", message: "Subagent task completed",
      }, onUpdate);
      await this.saveTask(task);
      return { taskId: task.detail.id, status: "completed", result: result.value ?? result.text };
    } catch (error) {
      const reason = this.interruptionReason(error, signal);
      task.detail.state = "interrupted";
      task.detail.endedAt = new Date().toISOString();
      task.detail.error = error instanceof Error ? error.message : String(error);
      task.detail.reason = reason;
      task.detail.resumable = reason !== "invalid_task";
      this.recordEvent(task.detail, this.runDirectory(task.detail.id), {
        timestamp: task.detail.endedAt, execution: task.detail.execution, type: "error", state: "interrupted", message: task.detail.error,
      }, onUpdate);
      await this.saveTask(task);
      return {
        taskId: task.detail.id,
        status: "interrupted",
        reason,
        last_completed_activity: task.lastCompletedActivity,
        current_activity: task.currentActivity,
        resumable: Boolean(task.detail.resumable),
      };
    }
  }

  private async runSingleObserved(options: ManagedRunOptions, observation?: TraceObservation): Promise<RunResult> {
    const managed = options.managed;
    const taskId = managed?.detail.id ?? randomUUID();
    const runId = managed?.detail.executionId ?? taskId;
    const sessionId = options.sessionId ?? taskId;
    const llm = resolveAgentLlm(
      this.config.runtime,
      options.profile.id,
      options.override ?? options.overrides?.[options.profile.id],
    );
    const detail: RunDetail = managed?.detail ?? {
      id: taskId,
      agent: options.profile.id,
      task: options.task,
      state: "running",
      startedAt: new Date().toISOString(),
      execution: 1,
      model: llm.model,
      thinking: llm.thinking,
      events: [],
    };
    const resumeCheckpoint = managed?.detail.stageAgent === options.profile.id ? managed.checkpoint : undefined;
    detail.model = llm.model;
    detail.thinking = llm.thinking;
    detail.stageAgent = options.profile.id;
    this.runs.set(taskId, detail);
    const runDirectory = this.runDirectory(taskId);
    await mkdir(runDirectory, { recursive: true });
    await this.saveSummary(runDirectory, detail);

    const tools = (options.profile.tools ?? [])
      .filter((name) => name !== "delegate_agent" && !isNativeToolName(name) && !isContractStateToolName(name))
      .map((name) => {
        const definition = this.toolDefinitions.get(name);
        if (!definition) throw new Error(`Subagent '${options.profile.id}' references unknown tool '${name}'.`);
        return definition;
      });
    const contractState = options.profile.contractState
      ? await this.initialContractState(options.profile, sessionId, options.task)
      : undefined;
    const request: ChildRequest = {
      taskId,
      runId,
      sessionId,
      projectRoot: this.config.cwd,
      dataDirectory: this.config.dataDirectory,
      datasetPath: this.config.datasetPath,
      maxDistinctProducts: this.config.runtime.market.maxDistinctProducts,
      llm: this.config.runtime.llm,
      task: options.task,
      profile: options.profile,
      model: detail.model,
      thinking: detail.thinking,
      tools,
      contractState,
      trustedRoute: this.routeFromTask(options.task),
      execution: detail.execution,
      checkpoint: resumeCheckpoint,
      traceContext: this.tracing.context(sessionId),
    };
    try {
      const result = await this.runAttempt(request, runDirectory, detail, detail.execution, options.signal, options.onUpdate, managed);
      if (managed) {
        managed.checkpoint = undefined;
        managed.lastCompletedActivity = `Completed ${options.profile.id}`;
        managed.currentActivity = managed.lastCompletedActivity;
        await this.saveTask(managed);
      }
      observation?.update({
        output: result.value ?? result.text,
        metadata: {
          taskId,
          subagentType: options.profile.id,
          executionId: runId,
          execution: detail.execution,
          status: "completed",
          resumed: Boolean(managed && detail.execution > 1),
        },
      });
      return result;
    } catch (error) {
      observation?.fail?.(error, Boolean(options.signal?.aborted));
      observation?.update({
        output: { error: error instanceof Error ? error.message : String(error) },
        metadata: {
          taskId,
          subagentType: options.profile.id,
          executionId: runId,
          execution: detail.execution,
          status: "interrupted",
          reason: this.interruptionReason(error, options.signal),
          resumed: Boolean(managed && detail.execution > 1),
        },
      });
      throw error;
    }
  }

  private routeFromTask(task: string): { node_id: string; node_name: string; node_path: string } | undefined {
    let value: unknown;
    try {
      value = JSON.parse(task);
    } catch {
      return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const route = record.route && typeof record.route === "object" && !Array.isArray(record.route)
      ? record.route as Record<string, unknown>
      : record;
    if (typeof route.node_id !== "string" || typeof route.node_name !== "string" || typeof route.node_path !== "string") {
      return undefined;
    }
    if (!/^\d+$/.test(route.node_id) || !route.node_name.trim() || !route.node_path.trim()) return undefined;
    return { node_id: route.node_id, node_name: route.node_name.trim(), node_path: route.node_path.trim() };
  }

  private artifactDirectory(): string {
    return path.join(this.config.dataDirectory, "market-criteria");
  }

  private async cachedMarket(task: string): Promise<RunResult | undefined> {
    const route = this.routeFromTask(task);
    if (!route) return undefined;
    const marketPath = path.join(this.artifactDirectory(), route.node_id, "market.json");
    try {
      const text = await readFile(marketPath, "utf8");
      const value = JSON.parse(text) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("market artifact is not a JSON object");
      const document = value as Record<string, unknown>;
      if (Object.keys(document).sort().join(",") !== "attributes,criteria,node" || !Array.isArray(document.criteria) || !Array.isArray(document.attributes)) {
        throw new Error("market artifact is not a canonical contract document");
      }
      return { text: JSON.stringify(value), value, runId: `cached-${randomUUID()}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) throw new Error(`Cached market artifact is invalid: ${marketPath}`);
      throw error;
    }
  }

  private async hasBase(task: string): Promise<boolean> {
    const route = this.routeFromTask(task);
    if (!route) return false;
    try {
      await access(path.join(this.artifactDirectory(), route.node_id, "base.json"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private marketTask(task: string): string {
    const route = this.routeFromTask(task);
    if (!route) return task;
    return JSON.stringify(route);
  }

  private async runCriteriaAndMarket(options: ManagedRunOptions): Promise<RunResult> {
    return this.tracing.withObservation("build-market-criteria", "chain", {
      input: options.task,
    }, async (chain) => {
    const marketProfile = this.config.agents.find((profile) => profile.id === "market_agent");
    if (!marketProfile) {
      const result = await this.runSingle(options);
      chain?.update({ output: result.value ?? result.text, metadata: { marketProfile: false } });
      return result;
    }
    const cached = await this.tracing.withObservation("check-market-cache", "span", { input: this.routeFromTask(options.task) }, async (span) => {
      const result = await this.cachedMarket(options.task);
      span?.update({ output: { hit: Boolean(result) }, metadata: { cache: "market", hit: Boolean(result) } });
      return result;
    });
    if (cached) {
      chain?.update({ output: cached.value ?? cached.text, metadata: { cache: "market", hit: true } });
      return cached;
    }
    const hasBase = await this.tracing.withObservation("check-base-cache", "span", { input: this.routeFromTask(options.task) }, async (span) => {
      const hit = await this.hasBase(options.task);
      span?.update({ output: { hit }, metadata: { cache: "base", hit } });
      return hit;
    });
    if (hasBase) {
      const result = await this.runSingle({
        ...options,
        profile: marketProfile,
        task: this.marketTask(options.task),
        override: options.overrides?.[marketProfile.id],
      });
      chain?.update({ output: result.value ?? result.text, metadata: { cache: "base", hit: true } });
      return result;
    }
    await this.runSingle(options);
    const result = await this.runSingle({
      ...options,
      profile: marketProfile,
      task: this.marketTask(options.task),
      override: options.overrides?.[marketProfile.id],
    });
    chain?.update({ output: result.value ?? result.text, metadata: { cache: "miss" } });
    return result;
    });
  }

  private async initialContractState(profile: ResolvedAgentProfile, sessionId: string, task: string): Promise<ContractState> {
    const existing = this.contractStates.get(this.contractStateKey(sessionId, task));
    if (existing) return existing;
    if (profile.id !== "market_agent") return emptyContractState();
    const route = this.routeFromTask(task);
    if (!route) throw new Error("market_agent requires a trusted taxonomy route to initialize contract state.");
    const basePath = path.join(this.artifactDirectory(), route.node_id, "base.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(basePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`market_agent base criteria artifact is not available: ${basePath}`);
      }
      if (error instanceof SyntaxError) throw new Error(`Cached base criteria artifact is invalid: ${basePath}`);
      throw error;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Cached base criteria artifact is not an object: ${basePath}`);
    }
    const document = parsed as Record<string, unknown>;
    if (Object.keys(document).sort().join(",") !== "attributes,criteria,node") {
      throw new Error(`Cached base criteria artifact has an invalid shape: ${basePath}`);
    }
    if (!Array.isArray(document.criteria) || !Array.isArray(document.attributes)) {
      throw new Error(`Cached base criteria artifact is missing criteria or attributes: ${basePath}`);
    }
    return {
      criteria: document.criteria as ContractState["criteria"],
      attributes: document.attributes as ContractState["attributes"],
    };
  }

  private contractStateKey(sessionId: string, task: string): string {
    const route = this.routeFromTask(task);
    return `${sessionId}:${route?.node_id ?? "unrouted"}`;
  }

  private async runAttempt(
    request: ChildRequest,
    runDirectory: string,
    detail: RunDetail,
    execution: number,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
    managed?: ManagedTask,
  ): Promise<RunResult> {
    const child = spawn(process.execPath, [CHILD_RUNNER], {
      cwd: this.config.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.children.add(child);
    child.stdin.write(`${JSON.stringify(request)}\n`);
    let buffer = "";
    let stderr = "";
    let finalResult: Extract<ChildEvent, { type: "result" }> | undefined;
    let childError: string | undefined;
    let timedOut = false;
    let reportedReasoning = false;
    let reportedWriting = false;
    const pythonRequests = new Map<string, AbortController>();
    let checkpointWrite = Promise.resolve();

    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = resolveSubagentTimeout(this.config.runtime, request.profile);
    const requestStop = (reason: "user" | "timeout") => {
      if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ type: "abort", reason })}\n`);
      stopTimer ??= setTimeout(() => this.terminate(child), 3_000);
    };
    const abort = () => requestStop("user");
    const timeout = setTimeout(() => {
      timedOut = true;
      requestStop("timeout");
    }, timeoutMs);
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
            detail.state = "running";
            if (managed) managed.currentActivity = event.message;
            this.recordEvent(detail, runDirectory, {
              timestamp: new Date().toISOString(), execution, type: "status", state: "running", message: event.message,
            }, onUpdate);
          } else if (event.type === "thinking_delta" && !reportedReasoning) {
            reportedReasoning = true;
            this.recordEvent(detail, runDirectory, {
              timestamp: new Date().toISOString(), execution, type: "reasoning", state: "running", message: "Analyzing task",
            }, onUpdate);
          } else if (event.type === "text_delta") {
            if (!reportedWriting) {
              reportedWriting = true;
              this.recordEvent(detail, runDirectory, {
                timestamp: new Date().toISOString(), execution, type: "writing", state: "running", message: "Writing response",
              }, onUpdate);
            }
          } else if (event.type === "tool_start") {
            if (event.name === DEVELOPER_ISSUE_TOOL) continue;
            if (managed) managed.currentActivity = `Running ${event.name}`;
            this.recordEvent(detail, runDirectory, {
              timestamp: new Date().toISOString(), execution, type: "tool_start", state: "running", tool: event.name, args: event.args,
            }, onUpdate);
          } else if (event.type === "tool_end") {
            if (event.name === DEVELOPER_ISSUE_TOOL) continue;
            if (managed) managed.currentActivity = event.isError ? `${event.name} failed` : "Committing completed turn";
            const result = event.name === WEB_SEARCH_TOOL
              ? (event.isError ? "web_search failed" : "web_search completed")
              : event.result;
            this.recordEvent(detail, runDirectory, {
              timestamp: new Date().toISOString(), execution, type: "tool_end", state: "running", tool: event.name,
              result, isError: event.isError,
            }, onUpdate);
          } else if (event.type === "checkpoint") {
            if (managed) {
              managed.checkpoint = event.checkpoint;
              managed.lastCompletedActivity = event.checkpoint.lastCompletedActivity;
              managed.currentActivity = `Continuing after ${event.checkpoint.lastCompletedActivity}`;
              checkpointWrite = checkpointWrite.then(() => this.saveCheckpoint(managed));
            }
            this.recordEvent(detail, runDirectory, {
              timestamp: new Date().toISOString(), execution, type: "checkpoint", state: "running", message: event.checkpoint.lastCompletedActivity,
            }, onUpdate);
          } else if (event.type === "python_request") {
            const controller = new AbortController();
            pythonRequests.set(event.id, controller);
            void this.handlePythonRequest(request, event, controller.signal).then(
              (result) => {
                if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ type: "python_response", id: event.id, ok: true, result })}\n`);
              },
              (error) => {
                if (child.stdin.writable) child.stdin.write(`${JSON.stringify({ type: "python_response", id: event.id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
              },
            ).finally(() => pythonRequests.delete(event.id));
          } else if (event.type === "python_cancel") {
            pythonRequests.get(event.id)?.abort();
          } else if (event.type === "result") {
            finalResult = event;
          } else if (event.type === "error") {
            childError = event.message;
            this.recordEvent(detail, runDirectory, {
              timestamp: new Date().toISOString(), execution, type: "error", message: `Execution ${execution} failed: ${event.message}`,
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
      this.children.delete(child);
      for (const controller of pythonRequests.values()) controller.abort();
      pythonRequests.clear();
      clearTimeout(timeout);
      if (stopTimer) clearTimeout(stopTimer);
      signal?.removeEventListener("abort", abort);
    });
    await checkpointWrite;

    if (signal?.aborted) throw new Error(`Subagent '${request.profile.id}' was aborted.`);
    if (timedOut) throw new Error(`Subagent '${request.profile.id}' timed out after ${timeoutMs}ms.`);
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
    detail.state = managed ? "running" : "completed";
    if (!managed) {
      detail.endedAt = new Date().toISOString();
      detail.output = finalResult.text;
      detail.value = finalResult.value;
    }
    this.recordEvent(detail, runDirectory, {
      timestamp: new Date().toISOString(), execution, type: "result", state: detail.state,
      message: managed ? `${request.profile.id} stage completed` : "Subagent completed",
    }, onUpdate);
    await this.saveSummary(runDirectory, detail);
    return { text: finalResult.text, value: finalResult.value, runId: request.runId };
  }

  private requirePython(): PythonExecutor {
    if (!this.python) throw new Error("SubagentManager requires a shared PythonExecutor for Python operations.");
    return this.python;
  }

  private async handlePythonRequest(request: ChildRequest, event: Extract<ChildEvent, { type: "python_request" }>, signal?: AbortSignal): Promise<unknown> {
    const python = this.requirePython();
    if (event.operation === "tool") {
      const allowed = request.tools.find((definition) => definition.name === event.tool);
      if (!allowed || !(request.profile.tools ?? []).includes(event.tool)) {
        throw new Error(`Subagent '${request.profile.id}' is not allowed to call Python tool '${event.tool}'.`);
      }
      return python.executeTool(allowed, event.callId, event.arguments, event.context, signal);
    }
    const contractStateOperation = request.profile.id === "research_agent"
      ? "persist_base"
      : request.profile.id === "market_agent"
        ? "publish_market"
        : undefined;
    const contractStateFinalizer = Boolean(request.profile.contractState)
      && event.validator === "market_v1"
      && contractStateOperation !== undefined
      && event.context?.operation === contractStateOperation;
    if (request.profile.outputValidator?.id !== event.validator && !contractStateFinalizer) {
      throw new Error(`Subagent '${request.profile.id}' is not allowed to call trusted validator '${event.validator}'.`);
    }
    const context = contractStateFinalizer
      ? {
        ...(event.context ?? {}),
        sessionId: request.sessionId,
        runId: request.runId,
        dataDirectory: request.dataDirectory,
        datasetPath: request.datasetPath,
        maxDistinctProducts: request.maxDistinctProducts,
        agentName: request.profile.id,
        operation: contractStateOperation,
      }
      : event.context;
    const result = await python.validate({ id: event.validator }, event.value, context, signal);
    if (!result.valid) throw new Error(result.error);
    return result.value;
  }

  async close(): Promise<void> {
    const children = [...this.children];
    this.children.clear();
    const closed = children.map((child) => child.exitCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("close", () => resolve())));
    for (const child of children) this.terminate(child);
    await Promise.all(closed);
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
      taskId: detail.id,
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

  private runDirectory(taskId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(taskId)) throw new Error(`Invalid subagent task id: ${taskId}`);
    return path.join(this.config.dataDirectory, "runs", taskId);
  }

  private async saveTask(task: ManagedTask): Promise<void> {
    const directory = this.runDirectory(task.detail.id);
    await mkdir(directory, { recursive: true });
    await Promise.all([
      this.saveSummary(directory, task.detail),
      writeFile(path.join(directory, "task.json"), `${JSON.stringify({
        version: 1,
        taskId: task.detail.id,
        sessionId: task.sessionId,
        requestedAgent: task.requestedAgent,
        override: task.override,
        overrides: task.overrides,
        currentActivity: task.currentActivity,
        lastCompletedActivity: task.lastCompletedActivity,
        model: task.detail.model,
        thinking: task.detail.thinking,
        hasCheckpoint: Boolean(task.checkpoint),
      }, null, 2)}\n`, "utf8"),
    ]);
    if (task.checkpoint) await this.saveCheckpoint(task, false);
  }

  private async saveCheckpoint(task: ManagedTask, updateSpec = true): Promise<void> {
    if (!task.checkpoint) return;
    const directory = this.runDirectory(task.detail.id);
    await writeFile(path.join(directory, "checkpoint.json"), `${JSON.stringify(task.checkpoint)}\n`, "utf8");
    if (updateSpec) await this.saveTask(task);
  }

  private async loadTask(taskId: string): Promise<ManagedTask> {
    const existing = this.tasks.get(taskId);
    if (existing) return existing;
    const directory = this.runDirectory(taskId);
    let spec: any;
    let detail: RunDetail;
    try {
      spec = JSON.parse(await readFile(path.join(directory, "task.json"), "utf8"));
      detail = JSON.parse(await readFile(path.join(directory, "status.json"), "utf8")) as RunDetail;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Unknown subagent task: ${taskId}`);
      throw new Error(`Subagent task '${taskId}' has invalid persisted state: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (spec?.version !== 1 || spec.taskId !== taskId || typeof spec.requestedAgent !== "string" || typeof spec.sessionId !== "string") {
      throw new Error(`Subagent task '${taskId}' has invalid persisted metadata.`);
    }
    let events: RunEvent[] = [];
    try {
      events = (await readFile(path.join(directory, "events.jsonl"), "utf8"))
        .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as RunEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let checkpoint: SubagentCheckpoint | undefined;
    if (spec.hasCheckpoint) checkpoint = JSON.parse(await readFile(path.join(directory, "checkpoint.json"), "utf8")) as SubagentCheckpoint;
    detail.events = events;
    detail.model = spec.model ?? "";
    detail.thinking = spec.thinking ?? "off";
    const task: ManagedTask = {
      detail,
      sessionId: spec.sessionId,
      requestedAgent: spec.requestedAgent,
      override: spec.override,
      overrides: spec.overrides,
      checkpoint,
      currentActivity: spec.currentActivity ?? "Interrupted",
      lastCompletedActivity: spec.lastCompletedActivity ?? "Task initialized",
    };
    const staleRunning = detail.state === "running";
    if (staleRunning) {
      detail.state = "interrupted";
      detail.endedAt = new Date().toISOString();
      detail.error = "The previous application process ended while this subagent task was running.";
      detail.reason = "process_error";
      detail.resumable = true;
      task.currentActivity = spec.currentActivity ?? "Previous execution stopped unexpectedly";
    }
    this.tasks.set(taskId, task);
    this.runs.set(taskId, detail);
    if (staleRunning) await this.saveTask(task);
    return task;
  }

  private interruptionReason(error: unknown, signal?: AbortSignal): string {
    const message = error instanceof Error ? error.message : String(error);
    if (signal?.aborted || /aborted/i.test(message)) return "aborted";
    if (/timed out|timeout/i.test(message)) return "execution_timeout";
    if (/exited with code|invalid child event|EPIPE|spawn/i.test(message)) return "process_error";
    if (/unknown agent|unknown tool|invalid persisted|requires a trusted|invalid task/i.test(message)) return "invalid_task";
    return "provider_error";
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
