import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PythonExecutor } from "./python-executor.ts";
import type { TrustedValidationResult, TrustedValidatorContext } from "./output-validator.ts";
import type { OutputValidatorConfig, PythonConfig, PythonToolDefinition, PythonToolRuntimeContext } from "./types.ts";

const WORKER_ENTRY = fileURLToPath(new URL("./python/worker.py", import.meta.url));
const BASE_ENV = ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT", "COMSPEC"];
const ENVIRONMENT_ERROR = "Python environment not found. Run `uv sync` from the project root.";

type RpcResponse = { id?: string; type?: string; ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
type QueueItem = {
  id: string;
  method: "tool.execute" | "validator.execute" | "health.ping";
  params: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  abort?: () => void;
};

export function resolveVenvPython(projectRoot: string): string {
  return process.platform === "win32"
    ? path.join(projectRoot, ".venv", "Scripts", "python.exe")
    : path.join(projectRoot, ".venv", "bin", "python");
}

export class PythonWorker implements PythonExecutor {
  private readonly projectRoot: string;
  private readonly config: PythonConfig;
  private readonly definitions: Map<string, PythonToolDefinition>;
  private child?: ChildProcessWithoutNullStreams;
  private readonly queue: QueueItem[] = [];
  private active?: QueueItem;
  private buffer = "";
  private ready?: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private starting?: Promise<void>;
  private closing = false;
  private restarting = false;
  private sequence = 0;

  constructor(projectRoot: string, config: PythonConfig, definitions: Map<string, PythonToolDefinition>) {
    this.projectRoot = projectRoot;
    this.config = config;
    this.definitions = definitions;
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = this.startProcess().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async startProcess(): Promise<void> {
    const executable = resolveVenvPython(this.projectRoot);
    try {
      await access(executable);
    } catch {
      throw new Error(ENVIRONMENT_ERROR);
    }
    const env: NodeJS.ProcessEnv = { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
    for (const name of BASE_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
    const child = spawn(executable, ["-X", "utf8", WORKER_ENTRY], {
      cwd: this.projectRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => process.stderr.write(chunk));
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.once("error", (error) => this.onCrash(error));
    child.once("close", (code) => {
      if (this.child === child) this.onCrash(new Error(`Python worker exited with code ${code}.`));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Python worker did not become ready.")), 15_000);
        this.ready = { resolve, reject, timer };
      });
      await this.initialize(child);
    } catch (error) {
      if (this.child === child) this.child = undefined;
      if (child.exitCode === null && !child.killed) this.terminate(child);
      throw error;
    }
  }

  private initialize(child: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise((resolve, reject) => {
      const tools = [...this.definitions.values()].map((definition) => ({ name: definition.name, entry: definition.entry }));
      const id = `initialize-${++this.sequence}`;
      const timer = setTimeout(() => reject(new Error("Python worker initialization timed out.")), 15_000);
      const item: QueueItem = {
        id, method: "health.ping", params: {}, timeoutMs: 15_000,
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      };
      // Initialization is the sole RPC allowed to carry registered paths.
      this.active = item;
      child.stdin.write(`${JSON.stringify({ id, method: "initialize", params: { projectRoot: this.projectRoot, tools } })}\n`);
    }).finally(() => {
      if (this.active?.id.startsWith("initialize-")) this.active = undefined;
      this.pump();
    });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let response: RpcResponse;
      try { response = JSON.parse(line) as RpcResponse; } catch { this.onCrash(new Error("Python worker returned invalid JSONL.")); return; }
      if (response.type === "ready") {
        if (this.ready) {
          clearTimeout(this.ready.timer);
          this.ready.resolve();
          this.ready = undefined;
        }
        continue;
      }
      const active = this.active;
      if (!active || response.id !== active.id) continue;
      this.active = undefined;
      if (active.abort) active.signal?.removeEventListener("abort", active.abort);
      if (response.ok) active.resolve(response.result);
      else active.reject(new Error(`${response.error?.code ?? "PYTHON_ERROR"}: ${response.error?.message ?? "Unknown Python error"}`));
      this.pump();
    }
  }

  private enqueue(method: QueueItem["method"], params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.closing) return Promise.reject(new Error("Python worker is closed."));
    return new Promise((resolve, reject) => {
      const item: QueueItem = { id: `python-${++this.sequence}`, method, params, timeoutMs, signal, resolve, reject };
      const abort = () => {
        const index = this.queue.indexOf(item);
        if (index >= 0) {
          this.queue.splice(index, 1);
          reject(new Error("Python request was aborted while queued."));
          return;
        }
        if (this.active === item) void this.fatal(new Error("Python request was aborted while running."));
      };
      item.abort = abort;
      if (signal?.aborted) { reject(new Error("Python request was aborted while queued.")); return; }
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(item);
      void this.start().then(() => this.pump(), reject);
    });
  }

  private pump(): void {
    if (!this.child || this.active || this.closing) return;
    const item = this.queue.shift();
    if (!item) return;
    this.active = item;
    const timer = setTimeout(() => void this.fatal(new Error(`Python request timed out after ${item.timeoutMs}ms.`)), item.timeoutMs);
    const resolve = item.resolve;
    const reject = item.reject;
    item.resolve = (value) => { clearTimeout(timer); resolve(value); };
    item.reject = (error) => { clearTimeout(timer); reject(error); };
    this.child.stdin.write(`${JSON.stringify({ id: item.id, method: item.method, params: item.params })}\n`);
  }

  private onCrash(error: Error): void {
    if (this.closing || !this.child) return;
    void this.fatal(error);
  }

  private async fatal(error: Error): Promise<void> {
    if (this.ready) {
      clearTimeout(this.ready.timer);
      this.ready.reject(error);
      this.ready = undefined;
    }
    const child = this.child;
    this.child = undefined;
    const failed = [this.active, ...this.queue].filter((item): item is QueueItem => Boolean(item));
    this.active = undefined;
    this.queue.length = 0;
    for (const item of failed) {
      if (item.abort) item.signal?.removeEventListener("abort", item.abort);
      item.reject(error);
    }
    if (child && child.exitCode === null && !child.killed) this.terminate(child);
    if (!this.closing && !this.restarting) {
      this.restarting = true;
      try { await this.start(); } catch { /* The next request may retry startup. */ }
      finally { this.restarting = false; }
    }
  }

  private environment(definition?: PythonToolDefinition): Record<string, string> {
    const result: Record<string, string> = {};
    const names = new Set([...this.config.envAllowlist, ...(definition?.env ?? [])]);
    for (const name of names) if (process.env[name] !== undefined) result[name] = process.env[name]!;
    return result;
  }

  executeTool(definition: PythonToolDefinition, callId: string, argumentsValue: unknown, context?: PythonToolRuntimeContext, signal?: AbortSignal): Promise<unknown> {
    if (this.definitions.get(definition.name)?.entry !== definition.entry) return Promise.reject(new Error(`Unknown Python tool '${definition.name}'.`));
    return this.enqueue("tool.execute", { tool: definition.name, callId, arguments: argumentsValue, context: context ?? {}, env: this.environment(definition) }, definition.timeoutMs ?? this.config.timeoutMs, signal);
  }

  async validate(validator: OutputValidatorConfig, value: unknown, context?: TrustedValidatorContext, signal?: AbortSignal): Promise<TrustedValidationResult> {
    try {
      const result = await this.enqueue("validator.execute", { validator: validator.id, value, context: context ?? {}, env: this.environment() }, Math.min(Math.max(this.config.timeoutMs, 1_000), 30_000), signal);
      return { valid: true, value: result };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async ping(): Promise<void> { await this.enqueue("health.ping", {}, 5_000); }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const error = new Error("Python worker is closing.");
    for (const item of [this.active, ...this.queue]) item?.reject(error);
    this.active = undefined;
    this.queue.length = 0;
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    child.stdin.write(`${JSON.stringify({ id: `shutdown-${++this.sequence}`, method: "worker.shutdown", params: {} })}\n`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.terminate(child); resolve(); }, 2_000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
    });
  }

  private terminate(child: ChildProcessWithoutNullStreams): void {
    child.kill();
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.unref();
    }
  }
}

export { ENVIRONMENT_ERROR };
