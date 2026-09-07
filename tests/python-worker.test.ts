import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverPythonTools } from "../src/framework/python-tools.ts";
import { ENVIRONMENT_ERROR, PythonWorker } from "../src/framework/python-worker.ts";
import { ChildPythonProxy } from "../src/framework/subagents/python-proxy.ts";

const cwd = path.resolve(import.meta.dirname, "..");
const definitions = await discoverPythonTools(cwd, ["tests/fixtures"]);
const definition = definitions.get("worker_test")!;

function value(result: unknown): { pid: number; hasOpenCodeKey: boolean; allowed?: string } {
  return result as { pid: number; hasOpenCodeKey: boolean; allowed?: string };
}

test("reuses one worker, isolates env, and redirects tool print away from JSONL", async () => {
  const previousSecret = process.env.OPENCODE_API_KEY;
  const previousAllowed = process.env.WORKER_ALLOWED_TEST;
  process.env.OPENCODE_API_KEY = "never-forward-this";
  process.env.WORKER_ALLOWED_TEST = "forward-this";
  const worker = new PythonWorker(cwd, { timeoutMs: 5_000, envAllowlist: [] }, definitions);
  try {
    await worker.start();
    const first = value(await worker.executeTool(definition, "one", { action: "pid" }));
    const second = value(await worker.executeTool(definition, "two", { action: "print" }));
    assert.equal(second.pid, first.pid);
    assert.equal(second.allowed, "forward-this");
    assert.equal(second.hasOpenCodeKey, false);
  } finally {
    await worker.close();
    if (previousSecret === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = previousSecret;
    if (previousAllowed === undefined) delete process.env.WORKER_ALLOWED_TEST; else process.env.WORKER_ALLOWED_TEST = previousAllowed;
  }
});

test("crash fails active and queued requests, restarts once, and never replays", async () => {
  const worker = new PythonWorker(cwd, { timeoutMs: 5_000, envAllowlist: [] }, definitions);
  try {
    await worker.start();
    const original = value(await worker.executeTool(definition, "before", { action: "pid" }));
    const crashed = worker.executeTool(definition, "crash", { action: "crash" });
    const queued = worker.executeTool(definition, "queued", { action: "pid" });
    await assert.rejects(crashed, /exited with code 23/);
    await assert.rejects(queued, /exited with code 23/);
    const restarted = value(await worker.executeTool(definition, "after", { action: "pid" }));
    assert.notEqual(restarted.pid, original.pid);
  } finally {
    await worker.close();
  }
});

test("ordinary tool exceptions do not restart the worker", async () => {
  const worker = new PythonWorker(cwd, { timeoutMs: 5_000, envAllowlist: [] }, definitions);
  try {
    await worker.start();
    const before = value(await worker.executeTool(definition, "before-error", { action: "pid" }));
    await assert.rejects(worker.executeTool(definition, "error", { action: "error" }), /ordinary tool failure/);
    const after = value(await worker.executeTool(definition, "after-error", { action: "pid" }));
    assert.equal(after.pid, before.pid);
  } finally {
    await worker.close();
  }
});

test("queued abort does not affect worker; running timeout does and permits calls after restart", async () => {
  const worker = new PythonWorker(cwd, { timeoutMs: 5_000, envAllowlist: [] }, definitions);
  try {
    await worker.start();
    const running = worker.executeTool(definition, "running", { action: "sleep", seconds: 0.15 });
    const controller = new AbortController();
    const queued = worker.executeTool(definition, "queued", { action: "pid" }, undefined, controller.signal);
    controller.abort();
    await assert.rejects(queued, /aborted while queued/);
    await running;

    const short = { ...definition, timeoutMs: 30 };
    await assert.rejects(worker.executeTool(short, "timeout", { action: "sleep", seconds: 1 }), /timed out/);
    assert.equal(typeof value(await worker.executeTool(definition, "after-timeout", { action: "pid" })).pid, "number");
  } finally {
    await worker.close();
  }
});

test("running abort kills and restarts the worker", async () => {
  const worker = new PythonWorker(cwd, { timeoutMs: 5_000, envAllowlist: [] }, definitions);
  try {
    await worker.start();
    const before = value(await worker.executeTool(definition, "before-abort", { action: "pid" }));
    const controller = new AbortController();
    const running = worker.executeTool(definition, "abort", { action: "sleep", seconds: 1 }, undefined, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await assert.rejects(running, /aborted while running/);
    const after = value(await worker.executeTool(definition, "after-abort", { action: "pid" }));
    assert.notEqual(after.pid, before.pid);
  } finally {
    await worker.close();
  }
});

test("child proxy routes requests through the parent-owned worker", async () => {
  const worker = new PythonWorker(cwd, { timeoutMs: 5_000, envAllowlist: [] }, definitions);
  const input = new EventEmitter();
  const proxy = new ChildPythonProxy(input as never, (event) => {
    if (event.type !== "python_request" || event.operation !== "tool") return;
    void worker.executeTool(definition, event.callId, event.arguments, event.context).then(
      (result) => input.emit("line", JSON.stringify({ type: "python_response", id: event.id, ok: true, result })),
      (error) => input.emit("line", JSON.stringify({ type: "python_response", id: event.id, ok: false, error: String(error) })),
    );
  });
  try {
    await worker.start();
    assert.equal(typeof value(await proxy.executeTool(definition, "proxy", { action: "pid" })).pid, "number");
  } finally {
    await proxy.close();
    await worker.close();
  }
});

test("reports the exact setup instruction when repo-local .venv is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shop-agent-no-venv-"));
  try {
    const worker = new PythonWorker(root, { timeoutMs: 1_000, envAllowlist: [] }, new Map());
    await assert.rejects(worker.start(), new RegExp(ENVIRONMENT_ERROR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
