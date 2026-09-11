import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/framework/config.ts";
import { SubagentManager } from "../src/framework/subagents/manager.ts";
import { createDelegationTool } from "../src/framework/subagents/tool.ts";

const cwd = path.resolve(import.meta.dirname, "..");

test("an interrupted task resumes from a durable checkpoint with the same taskId and a new execution", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shop-agent-resume-"));
  try {
    const config = await loadConfig(cwd, undefined, { paths: { runtimeData: directory } });
    const profile = config.agents.find((item) => item.id === "delegate")!;
    const first = new SubagentManager(config, new Map());
    let firstExecutionId = "";
    (first as any).runAttempt = async (request: any, _directory: string, _detail: unknown, _execution: number, _signal: unknown, _update: unknown, managed: any) => {
      firstExecutionId = request.runId;
      managed.currentActivity = "Validating availability";
      managed.lastCompletedActivity = "Collected candidate products";
      managed.checkpoint = {
        messages: [{ role: "user", content: "work", timestamp: Date.now() }],
        lastCompletedActivity: managed.lastCompletedActivity,
      };
      await (first as any).saveCheckpoint(managed);
      throw new Error("provider connection reset");
    };

    const interrupted = await first.delegate({ profile, task: "work", sessionId: "session-a" });
    assert.deepEqual(interrupted, {
      taskId: interrupted.taskId,
      status: "interrupted",
      reason: "provider_error",
      last_completed_activity: "Collected candidate products",
      current_activity: "Validating availability",
      resumable: true,
    });
    const interruptedStatus = JSON.parse(await readFile(path.join(directory, "runs", interrupted.taskId, "status.json"), "utf8"));
    assert.equal(interruptedStatus.reason, "provider_error");

    // A whole-app crash can leave the last durable status at running. A new
    // manager treats that as an interrupted execution before resuming it.
    await writeFile(
      path.join(directory, "runs", interrupted.taskId, "status.json"),
      `${JSON.stringify({ ...interruptedStatus, state: "running", endedAt: undefined, reason: undefined })}\n`,
      "utf8",
    );

    const second = new SubagentManager(config, new Map());
    let resumedRequest: any;
    (second as any).runAttempt = async (request: any) => {
      resumedRequest = request;
      return { text: "done", value: { answer: 42 }, runId: request.runId };
    };
    const completed = await second.resume(interrupted.taskId);

    assert.deepEqual(completed, { taskId: interrupted.taskId, status: "completed", result: { answer: 42 } });
    assert.equal(resumedRequest.taskId, interrupted.taskId);
    assert.notEqual(resumedRequest.runId, firstExecutionId);
    assert.equal(resumedRequest.execution, 2);
    assert.equal(resumedRequest.checkpoint.lastCompletedActivity, "Collected candidate products");
    const status = JSON.parse(await readFile(path.join(directory, "runs", interrupted.taskId, "status.json"), "utf8"));
    assert.equal(status.state, "completed");
    assert.equal(status.execution, 2);
    await assert.rejects(second.resume(interrupted.taskId), /completed and cannot be resumed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancel is terminal and resume accepts no new business instruction", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shop-agent-cancel-"));
  try {
    const config = await loadConfig(cwd, undefined, { paths: { runtimeData: directory } });
    const profile = config.agents.find((item) => item.id === "delegate")!;
    const manager = new SubagentManager(config, new Map());
    (manager as any).runAttempt = async () => { throw new Error("provider unavailable"); };
    const interrupted = await manager.delegate({ profile, task: "original task", sessionId: "session-a" });
    assert.equal(interrupted.status, "interrupted");
    const cancelled = await manager.cancel(interrupted.taskId);
    assert.deepEqual(cancelled, { taskId: interrupted.taskId, status: "cancelled" });
    await assert.rejects(manager.resume(interrupted.taskId), /cancelled and cannot be resumed/);

    const tool = createDelegationTool(config.agents, manager, () => ({}), () => "session-a");
    await assert.rejects(
      tool.execute("resume", { action: "resume", taskId: interrupted.taskId, task: "changed task" }),
      /accepts only 'taskId'/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
