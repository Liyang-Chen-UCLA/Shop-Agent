import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/framework/config.ts";
import { SubagentManager } from "../src/framework/subagents/manager.ts";
import { createDelegationTool } from "../src/framework/subagents/tool.ts";

const cwd = path.resolve(import.meta.dirname, "..");
const route = {
  node_id: "3375",
  node_name: "乒乓底板",
  node_path: "体育用品 > 室内游戏 > 乒乓球用品 > 乒乓球拍",
};
const task = JSON.stringify(route);

async function setupManager() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shop-agent-market-"));
  const config = await loadConfig(cwd, undefined, { paths: { runtimeData: directory } });
  const manager = new SubagentManager(config, new Map());
  const research = config.agents.find((profile) => profile.id === "research_agent")!;
  return { directory, config, manager, research, market: config.agents.find((profile) => profile.id === "market_agent")! };
}

async function writeArtifact(directory: string, name: string, value: unknown): Promise<void> {
  const artifactDirectory = path.join(directory, "market-criteria", route.node_id);
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(path.join(artifactDirectory, name), `${JSON.stringify(value)}\n`, "utf8");
}

test("reuses an existing market artifact without starting a child", async () => {
  const { directory, manager, research } = await setupManager();
  try {
    const cached = { node: { id: route.node_id, name: route.node_name, path: route.node_path.split(" > ") }, criteria: [], attributes: [] };
    await writeArtifact(directory, "market.json", cached);
    const childRuns: string[] = [];
    (manager as any).runSingle = async () => {
      childRuns.push("unexpected");
      throw new Error("child should not run for a cached market");
    };

    const result = await manager.run({ profile: research, task, sessionId: "session" });
    assert.deepEqual(result.value, cached);
    assert.deepEqual(childRuns, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses an existing base artifact and runs only the market profile", async () => {
  const { directory, manager, research, market } = await setupManager();
  try {
    await writeArtifact(directory, "base.json", { node: route.node_id });
    const childRuns: Array<{ profile: string; task: string }> = [];
    (manager as any).runSingle = async (options: any) => {
      childRuns.push({ profile: options.profile.id, task: options.task });
      return { text: "market", value: { stage: "market" }, runId: "market-run" };
    };

    const result = await manager.run({ profile: research, task, sessionId: "session" });
    assert.equal(result.value && (result.value as any).stage, "market");
    assert.deepEqual(childRuns, [{ profile: market.id, task }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("initializes a Market contract state from the trusted base artifact", async () => {
  const { directory, manager, market } = await setupManager();
  try {
    const base = {
      node: { id: route.node_id, name: route.node_name, path: route.node_path.split(" > ") },
      criteria: [{
        id: "weight",
        name: "重量",
        description: "底板重量",
        aliases: [],
        type: "numeric",
        units: ["克"],
        direction: { type: "smaller_better" },
      }],
      attributes: [],
    };
    await writeArtifact(directory, "base.json", base);
    (manager as any).toolDefinitions.set("shopping_env", { name: "shopping_env" });
    let captured: any;
    (manager as any).runAttempt = async (request: any) => {
      captured = request;
      return {
        text: "market",
        value: { criteria: [{ ...base.criteria[0], observed_product_ids: [] }], attributes: [] },
        runId: request.runId,
      };
    };

    await manager.run({ profile: market, task, sessionId: "market-session" });
    assert.deepEqual(captured.contractState, { criteria: base.criteria, attributes: [] });
    assert.deepEqual(captured.profile.contractState.runtimeItemDefaults, { observed_product_ids: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runs research then market when neither artifact exists", async () => {
  const { directory, manager, research, market } = await setupManager();
  try {
    const calls: string[] = [];
    const childTasks: string[] = [];
    (manager as any).runSingle = async (options: any) => {
      calls.push(options.profile.id);
      childTasks.push(options.task);
      return { text: options.profile.id, value: { stage: options.profile.id }, runId: `${options.profile.id}-run` };
    };
    const result = await manager.run({ profile: research, task, sessionId: "session" });
    assert.equal(result.value && (result.value as any).stage, market.id);
    assert.deepEqual(calls, [research.id, market.id]);
    assert.deepEqual(childTasks, [task, task]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("delegate_agent uses resolved absolute paths for a subagent run", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shop-agent-run-path-"));
  try {
    const config = await loadConfig(cwd, undefined, { paths: { runtimeData: directory } });
    const manager = new SubagentManager(config, new Map());
    const profile = config.agents.find((item) => item.id === "delegate")!;
    let capturedRequest: { runId: string; dataDirectory: string; datasetPath: string } | undefined;
    let capturedRunDirectory: string | undefined;
    (manager as any).runAttempt = async (request: any, runDirectory: string) => {
      capturedRequest = request;
      capturedRunDirectory = runDirectory;
      return { text: "delegate result", runId: request.runId };
    };

    const delegation = createDelegationTool(config.agents, manager, () => ({}), () => "regression-session");
    const result = await delegation.execute("delegate-regression", {
      action: "delegate",
      agent: profile.id,
      task: "Return a short test result.",
    });
    const runId = (result.details as { taskId: string }).taskId;
    const expectedRunDirectory = path.join(directory, "runs", runId);

    assert.equal(capturedRunDirectory, expectedRunDirectory);
    assert.equal(capturedRequest!.dataDirectory, config.dataDirectory);
    assert.equal(capturedRequest!.datasetPath, config.datasetPath);
    const status = JSON.parse(await readFile(path.join(expectedRunDirectory, "status.json"), "utf8")) as { id: string };
    assert.equal(status.id, runId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
