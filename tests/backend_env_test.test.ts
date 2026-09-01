import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  BACKEND_ENV_TEST_SCENARIOS,
  formatBackendEnvTestTurn,
  probeBackendEnv,
  runBackendEnvTest,
  type BackendEnvProbe,
  type BackendEnvSampleSummary,
  type BackendEnvTestApp,
  type BackendEnvTestConfig,
} from "../src/backend-env-test.ts";
import { loadConfig } from "../src/framework/config.ts";
import type { TaskState } from "../src/framework/types.ts";

const projectRoot = path.resolve(import.meta.dirname, "..");

function projectPythonExecutable(): string {
  const configured = process.env.SHOP_AGENT_PYTHON?.trim();
  if (configured) return configured;
  return [
    "D:\\App\\miniforge3\\envs\\shop-agent\\python.exe",
    "F:\\Anaconda3\\envs\\shop-agent\\python.exe",
  ].find((candidate) => existsSync(candidate)) ?? "python";
}

function makeState(tasks: TaskState["tasks"]): TaskState {
  return {
    schema_version: 1,
    active_task_id: tasks[tasks.length - 1]?.task_id ?? null,
    tasks,
  };
}

function makeTask(taskId: string, scenario: (typeof BACKEND_ENV_TEST_SCENARIOS)[number], route = scenario.route): TaskState["tasks"][number] {
  return {
    task_id: taskId,
    product: scenario.product,
    preference: {},
    route,
  };
}

class FakeBackendApp implements BackendEnvTestApp {
  readonly prompts: string[] = [];
  private readonly messages: AgentMessage[] = [];
  private stateIndex = 0;
  readonly config: BackendEnvTestConfig;
  private readonly states: TaskState[];

  constructor(
    config: BackendEnvTestConfig,
    states: TaskState[],
  ) {
    this.config = config;
    this.states = states;
  }

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.messages.push({ role: "user", content: [{ type: "text", text }] } as never);
    this.messages.push({
      role: "assistant",
      content: [{ type: "text", text: `fake backend turn ${this.prompts.length}` }],
    } as never);
  }

  getMessages(): readonly AgentMessage[] {
    return this.messages;
  }

  async getTaskState(): Promise<TaskState> {
    const state = this.states[this.stateIndex++];
    if (!state) throw new Error("fake task state exhausted");
    return state;
  }
}

function samples(category: string, prefix: string): BackendEnvSampleSummary[] {
  return Array.from({ length: 5 }, (_, index) => ({
    category,
    item_id: `${prefix}-${index + 1}`,
    rank: index + 1,
    sample_index: index + 1,
  }));
}

async function writeMarketArtifact(
  config: BackendEnvTestConfig,
  scenario: (typeof BACKEND_ENV_TEST_SCENARIOS)[number],
  route: (typeof BACKEND_ENV_TEST_SCENARIOS)[number]["route"],
  selected: readonly BackendEnvSampleSummary[],
): Promise<void> {
  const directory = path.resolve(config.cwd, config.dataDirectory, "market-criteria", route.node_id);
  const productsDirectory = path.join(directory, "products");
  await mkdir(productsDirectory, { recursive: true });
  const productIds = selected.map((sample) => sample.item_id);
  await writeFile(path.join(directory, "market.json"), JSON.stringify({
    node: { id: route.node_id, name: route.node_name, path: route.node_path.split(">").map((part) => part.trim()) },
    dataset_category: scenario.datasetCategory,
    traversed_product_count: 5,
    product_ids: productIds,
    criteria: [],
    attributes: [],
  }), "utf8");
  for (const item_id of productIds) {
    await writeFile(path.join(productsDirectory, `${item_id}.json`), JSON.stringify({
      dataset_category: scenario.datasetCategory,
      item_id,
      criteria: [],
      attributes: [],
    }), "utf8");
  }
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shop-agent-backend-env-test-"));
  const config: BackendEnvTestConfig = {
    cwd: directory,
    dataDirectory: directory,
    datasetPath: path.join(directory, "products.parquet"),
    maxDistinctProducts: 5,
    python: { executable: "python", timeoutMs: 10_000, envAllowlist: [] },
    toolDirectories: ["shop/tools"],
  };
  const [dogFood, tableTennis, phoneLight] = BACKEND_ENV_TEST_SCENARIOS;
  const dogSamples = samples(dogFood.datasetCategory, "dog");
  const tableSamples = samples(tableTennis.datasetCategory, "table");
  const lightSamples = samples(phoneLight.datasetCategory, "light");
  const mobileRoute = phoneLight.acceptedRoutes[2]!;
  await writeMarketArtifact(config, dogFood, dogFood.route, dogSamples);
  await writeMarketArtifact(config, tableTennis, tableTennis.route, tableSamples);
  await writeMarketArtifact(config, phoneLight, mobileRoute, lightSamples);
  const app = new FakeBackendApp(config, [
    makeState([makeTask("dog-task", dogFood)]),
    makeState([makeTask("dog-task", dogFood), makeTask("table-task", tableTennis)]),
    makeState([
      makeTask("dog-task", dogFood),
      makeTask("table-task", tableTennis),
      makeTask("light-task", phoneLight, mobileRoute),
    ]),
  ]);
  const byScenario = new Map([
    [dogFood.id, dogSamples],
    [tableTennis.id, tableSamples],
    [phoneLight.id, lightSamples],
  ]);
  const probeCalls: string[] = [];
  const probe: BackendEnvProbe = async (scenario) => {
    probeCalls.push(scenario.id);
    return byScenario.get(scenario.id)!;
  };
  return { directory, config, app, probe, probeCalls, phoneLight, lightSamples, mobileRoute };
}

test("runs three categories through one fake app and verifies market artifacts", async () => {
  const value = await fixture();
  try {
    const output: string[] = [];
    const result = await runBackendEnvTest(value.app, {
      probe: value.probe,
      onTurn: (turn) => output.push(formatBackendEnvTestTurn(turn)),
    });
    assert.deepEqual(value.app.prompts, BACKEND_ENV_TEST_SCENARIOS.map((scenario) => scenario.prompt));
    assert.deepEqual(value.probeCalls, [
      "dog-food", "dog-food", "table-tennis", "table-tennis", "phone-fill-light", "phone-fill-light",
    ]);
    assert.equal(result.turns.length, 3);
    assert.equal(result.finalTaskState.active_task_id, "light-task");
    assert.deepEqual(result.finalTaskState.tasks.map((task) => task.task_id), ["dog-task", "table-task", "light-task"]);
    assert.equal(result.turns[2]?.taskState.tasks[2]?.route.node_id, "2394");
    assert.equal(output.length, 3);
    const record = JSON.parse(output[2]!) as { assistant_final: string; task_state: TaskState; env_samples: unknown[] };
    assert.equal(record.assistant_final, "fake backend turn 3");
    assert.equal(record.task_state.active_task_id, "light-task");
    assert.deepEqual(Object.keys(record.env_samples[0] as object), ["category", "item_id", "rank", "sample_index"]);
    assert.doesNotMatch(output[2]!, /ocr_text|OCR/);
    await readFile(path.join(path.resolve(value.config.cwd, value.config.dataDirectory, "market-criteria", value.mobileRoute.node_id), "market.json"), "utf8");
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("fails when a required market artifact is missing", async () => {
  const value = await fixture();
  try {
    await rm(path.resolve(value.config.cwd, value.config.dataDirectory, "market-criteria", value.mobileRoute.node_id, "market.json"), { force: true });
    await assert.rejects(
      () => runBackendEnvTest(value.app, { probe: value.probe }),
      /Market artifact is missing or invalid.*phone-fill-light/,
    );
  } finally {
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("probes the real dog-food backend env without creating a model run", async () => {
  const config = await loadConfig(projectRoot, undefined, {
    python: { executable: projectPythonExecutable() },
  });
  const scenario = BACKEND_ENV_TEST_SCENARIOS[0]!;
  const samples = await probeBackendEnv(scenario, config);
  assert.equal(samples.length, config.maxDistinctProducts);
  assert.deepEqual(samples.map((sample) => sample.sample_index), [1, 2, 3, 4, 5]);
  assert.equal(new Set(samples.map((sample) => sample.item_id)).size, config.maxDistinctProducts);
  assert.ok(samples.every((sample) => sample.category === scenario.datasetCategory));
});
