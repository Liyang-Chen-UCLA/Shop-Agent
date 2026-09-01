import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/framework/config.ts";
import { SubagentManager } from "../src/framework/subagents/manager.ts";

const cwd = path.resolve(import.meta.dirname, "..");
const route = {
  node_id: "3375",
  node_name: "乒乓底板",
  node_path: "体育用品 > 室内游戏 > 乒乓球用品 > 乒乓球拍",
};
const task = JSON.stringify(route);

async function setupManager() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shop-agent-market-"));
  const config = await loadConfig(cwd, undefined, { dataDirectory: directory });
  const manager = new SubagentManager(config, new Map());
  const criteria = config.agents.find((profile) => profile.id === "criteria_agent")!;
  return { directory, config, manager, criteria, market: config.agents.find((profile) => profile.id === "market_agent")! };
}

async function writeArtifact(directory: string, name: string, value: unknown): Promise<void> {
  const artifactDirectory = path.join(directory, "market-criteria", route.node_id);
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(path.join(artifactDirectory, name), `${JSON.stringify(value)}\n`, "utf8");
}

test("reuses an existing market artifact without starting a child", async () => {
  const { directory, manager, criteria } = await setupManager();
  try {
    const cached = { node: { id: route.node_id }, cached: true };
    await writeArtifact(directory, "market.json", cached);
    const childRuns: string[] = [];
    (manager as any).runSingle = async () => {
      childRuns.push("unexpected");
      throw new Error("child should not run for a cached market");
    };

    const result = await manager.run({ profile: criteria, task, sessionId: "session" });
    assert.deepEqual(result.value, cached);
    assert.deepEqual(childRuns, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses an existing base artifact and runs only the market profile", async () => {
  const { directory, manager, criteria, market } = await setupManager();
  try {
    await writeArtifact(directory, "base.json", { node: route.node_id });
    const childRuns: Array<{ profile: string; task: string }> = [];
    (manager as any).runSingle = async (options: any) => {
      childRuns.push({ profile: options.profile.id, task: options.task });
      return { text: "market", value: { stage: "market" }, runId: "market-run" };
    };

    const result = await manager.run({ profile: criteria, task, sessionId: "session" });
    assert.equal(result.value && (result.value as any).stage, "market");
    assert.deepEqual(childRuns, [{ profile: market.id, task }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runs criteria, persists base, then runs market when neither artifact exists", async () => {
  const { directory, manager, criteria, market } = await setupManager();
  try {
    const calls: string[] = [];
    const childTasks: string[] = [];
    (manager as any).runSingle = async (options: any) => {
      calls.push(options.profile.id);
      childTasks.push(options.task);
      return { text: options.profile.id, value: { stage: options.profile.id }, runId: `${options.profile.id}-run` };
    };
    (manager as any).persistBaseCriteria = async (_result: any, _sessionId: string, _runId: string) => {
      calls.push("persist_base");
    };

    const result = await manager.run({ profile: criteria, task, sessionId: "session" });
    assert.equal(result.value && (result.value as any).stage, market.id);
    assert.deepEqual(calls, [criteria.id, "persist_base", market.id]);
    assert.deepEqual(childTasks, [task, task]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
