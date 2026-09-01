import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { discoverPythonTools, createPythonAgentTools } from "./framework/python-tools.ts";
import { messageText } from "./framework/content.ts";
import type { PythonToolRuntimeContext, ResolvedConfig, TaskState } from "./framework/types.ts";

export type BackendEnvRoute = {
  node_id: string;
  node_name: string;
  node_path: string;
};

export type BackendEnvScenario = {
  id: string;
  product: string;
  prompt: string;
  route: BackendEnvRoute;
  acceptedRoutes: readonly BackendEnvRoute[];
  datasetCategory: string;
};

const DOG_FOOD_ROUTE = {
  node_id: "3530",
  node_name: "狗粮",
  node_path: "动物/宠物用品 > 宠物用品 > 狗狗用品 > 狗粮",
} as const;

const TABLE_TENNIS_ROUTE = {
  node_id: "3375",
  node_name: "乒乓球拍",
  node_path: "体育用品 > 室内游戏 > 乒乓球用品 > 乒乓球拍",
} as const;

const PHONE_ACCESSORY_ROUTE = {
  node_id: "264",
  node_name: "手机配件",
  node_path: "电子产品 > 通讯 > 电话 > 手机配件",
} as const;

const STUDIO_LIGHT_ROUTE = {
  node_id: "2926",
  node_name: "摄影室灯光与闪光灯",
  node_path: "相机与光学器件 > 照片冲印/摄影棚器材 > 摄影棚器材 > 摄影室灯光与闪光灯",
} as const;

const CAMCORDER_LIGHT_ROUTE = {
  node_id: "2394",
  node_name: "摄像机灯",
  node_path: "相机与光学器件 > 相机与光学器件配件 > 相机零配件 > 摄像机灯",
} as const;

/** Fixed prompts for a non-interactive three-category backend exercise. */
export const BACKEND_ENV_TEST_SCENARIOS: readonly BackendEnvScenario[] = [
  {
    id: "dog-food",
    product: "狗粮",
    prompt: "请直接创建并确认“狗粮”这个品类的分析任务。选择“狗粮”分类，不要选择“处方狗粮”或“非处方狗粮”子类；我确认停留在“狗粮”这一层，不再等待或询问人工确认。",
    route: DOG_FOOD_ROUTE,
    acceptedRoutes: [DOG_FOOD_ROUTE],
    datasetCategory: "狗全价膨化粮",
  },
  {
    id: "table-tennis",
    product: "乒乓球拍",
    prompt: "请直接创建并确认“乒乓球拍”这个品类的分析任务，停留在“乒乓球拍”分类；我确认使用这个分类，不再等待或询问人工确认。",
    route: TABLE_TENNIS_ROUTE,
    acceptedRoutes: [TABLE_TENNIS_ROUTE],
    datasetCategory: "乒乓底板",
  },
  {
    id: "phone-fill-light",
    product: "手机补光灯",
    prompt: "请直接创建并确认“手机补光灯”的品类分析任务：优先选择“手机配件”分类；如果路由工具将它明确归到“摄影室灯光与闪光灯”，就确认那个对应分类。无论选择哪一个，都停留在该分类，不再等待或询问人工确认。",
    route: PHONE_ACCESSORY_ROUTE,
    acceptedRoutes: [PHONE_ACCESSORY_ROUTE, STUDIO_LIGHT_ROUTE, CAMCORDER_LIGHT_ROUTE],
    datasetCategory: "手机直播补光灯",
  },
];

export type BackendEnvTestConfig = Pick<
  ResolvedConfig,
  "cwd" | "dataDirectory" | "datasetPath" | "maxDistinctProducts" | "python" | "toolDirectories"
>;

/** Narrow app surface required by this runner; a fake can implement it offline. */
export type BackendEnvTestApp = {
  config: BackendEnvTestConfig;
  prompt(text: string): Promise<void>;
  getMessages(): readonly AgentMessage[];
  getTaskState(): Promise<TaskState>;
};

export type BackendEnvSampleSummary = {
  category: string;
  item_id: string;
  rank: number | null;
  sample_index: number;
};

export type BackendEnvTestTurn = {
  turn: number;
  scenario: string;
  assistant: string;
  taskState: TaskState;
  envSamples: BackendEnvSampleSummary[];
};

export type BackendEnvArtifactSummary = {
  node_id: string;
  marketPath: string;
  productIds: string[];
};

export type BackendEnvTestResult = {
  turns: BackendEnvTestTurn[];
  finalTaskState: TaskState;
};

export type BackendEnvProbe = (
  scenario: BackendEnvScenario,
  config: BackendEnvTestConfig,
) => Promise<readonly BackendEnvSampleSummary[]>;

export type RunBackendEnvTestOptions = {
  scenarios?: readonly BackendEnvScenario[];
  /** Override the real Python probe for offline tests. It is called twice per category. */
  probe?: BackendEnvProbe;
  onTurn?: (turn: BackendEnvTestTurn, totalTurns: number) => void | Promise<void>;
};

type PythonTool = {
  name: string;
  execute(callId: string, args: unknown): Promise<unknown>;
};

function routePath(route: BackendEnvRoute): string[] {
  return route.node_path.split(">").map((part) => part.trim()).filter(Boolean);
}

function routeMatches(actual: unknown, expected: BackendEnvRoute): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const route = actual as Record<string, unknown>;
  return route.node_id === expected.node_id
    && route.node_name === expected.node_name
    && route.node_path === expected.node_path;
}

function acceptedRouteForTask(task: TaskState["tasks"][number], scenario: BackendEnvScenario): boolean {
  return scenario.acceptedRoutes.some((route) => routeMatches(task.route, route));
}

function parsePythonToolResult(result: unknown, label: string): unknown {
  if (!result || typeof result !== "object") throw new Error(`${label} returned no tool result.`);
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error(`${label} returned no text content.`);
  const text = content.find((item) => (
    !!item && typeof item === "object" && (item as { type?: unknown }).type === "text"
  )) as { text?: unknown } | undefined;
  if (!text || typeof text.text !== "string") throw new Error(`${label} returned no JSON text content.`);
  try {
    return JSON.parse(text.text);
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function findPythonTool(tools: PythonTool[], name: string): PythonTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Backend env test could not create Python tool '${name}'.`);
  return tool;
}

function validateSampleSummaries(
  samples: readonly BackendEnvSampleSummary[],
  scenario: BackendEnvScenario,
  config: BackendEnvTestConfig,
): void {
  if (samples.length !== config.maxDistinctProducts) {
    throw new Error(`Backend env ${scenario.id} returned ${samples.length} samples; expected ${config.maxDistinctProducts}.`);
  }
  const ids = new Set<string>();
  for (const [index, sample] of samples.entries()) {
    if (sample.category !== scenario.datasetCategory) {
      throw new Error(`Backend env ${scenario.id} sample ${index + 1} has category '${sample.category}', expected '${scenario.datasetCategory}'.`);
    }
    if (typeof sample.item_id !== "string" || !/^[A-Za-z0-9._-]+$/.test(sample.item_id)) {
      throw new Error(`Backend env ${scenario.id} sample ${index + 1} has an invalid item_id.`);
    }
    if (ids.has(sample.item_id)) {
      throw new Error(`Backend env ${scenario.id} returned duplicate item_id '${sample.item_id}'.`);
    }
    ids.add(sample.item_id);
    if (sample.sample_index !== index + 1) {
      throw new Error(`Backend env ${scenario.id} sample index is ${sample.sample_index}; expected ${index + 1}.`);
    }
    if (sample.rank !== null && (!Number.isInteger(sample.rank) || sample.rank < 0)) {
      throw new Error(`Backend env ${scenario.id} sample ${index + 1} has an invalid rank.`);
    }
  }
}

function snapshotState(state: TaskState): TaskState {
  return JSON.parse(JSON.stringify(state)) as TaskState;
}

function finalAssistantText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = messageText(message);
    if (text.trim()) return text;
  }
  return "";
}

function taskForScenario(state: TaskState, scenario: BackendEnvScenario): TaskState["tasks"][number] {
  const matches = state.tasks.filter((task) => acceptedRouteForTask(task, scenario));
  if (matches.length !== 1) {
    throw new Error(`Backend env scenario ${scenario.id} expected one matching task, got ${matches.length}.`);
  }
  const task = matches[0];
  if (!task || state.active_task_id !== task.task_id) {
    throw new Error(`Backend env scenario ${scenario.id} did not leave its task active.`);
  }
  return task;
}

/**
 * Run the real trusted task-state and shopping-env tools in an isolated UUID
 * session/run. The temporary directory is never the app's configured data
 * directory, so this preflight cannot change the conversation's task state or
 * its market cursor.
 */
export async function probeBackendEnv(
  scenario: BackendEnvScenario,
  config: BackendEnvTestConfig,
): Promise<readonly BackendEnvSampleSummary[]> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "shop-agent-backend-env-"));
  try {
    const context: PythonToolRuntimeContext = {
      sessionId: randomUUID(),
      runId: randomUUID(),
      dataDirectory: temporaryDirectory,
      datasetPath: path.resolve(config.cwd, config.datasetPath),
      maxDistinctProducts: config.maxDistinctProducts,
      agentName: "backend_env_test",
    };
    const definitions = await discoverPythonTools(config.cwd, config.toolDirectories);
    const tools = createPythonAgentTools(
      definitions,
      ["task_state_upsert", "shopping_env"],
      config.python,
      () => context,
    ) as PythonTool[];
    const upsert = findPythonTool(tools, "task_state_upsert");
    const shopping = findPythonTool(tools, "shopping_env");

    const upserted = parsePythonToolResult(
      await upsert.execute(`backend-env-upsert-${randomUUID()}`, {
        product: scenario.product,
        preference: {},
        route: scenario.route,
      }),
      "task_state_upsert",
    );
    if (!upserted || typeof upserted !== "object" || !routeMatches((upserted as { task?: { route?: unknown } }).task?.route, scenario.route)) {
      throw new Error(`task_state_upsert did not create the expected isolated route for ${scenario.id}.`);
    }

    const samples: BackendEnvSampleSummary[] = [];
    while (samples.length < config.maxDistinctProducts) {
      const value = parsePythonToolResult(
        await shopping.execute(`backend-env-shopping-${randomUUID()}`, {}),
        "shopping_env",
      );
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`shopping_env returned an invalid sample for ${scenario.id}.`);
      }
      const sample = value as Record<string, unknown>;
      if (sample.dataset_category !== scenario.datasetCategory || sample.category !== scenario.datasetCategory) {
        throw new Error(`shopping_env returned the wrong category for ${scenario.id}.`);
      }
      if (sample.sample_limit !== config.maxDistinctProducts) {
        throw new Error(`shopping_env returned sample_limit ${String(sample.sample_limit)} for ${scenario.id}; expected ${config.maxDistinctProducts}.`);
      }
      if (typeof sample.item_id !== "string" || !/^[A-Za-z0-9._-]+$/.test(sample.item_id)) {
        throw new Error(`shopping_env returned an invalid item_id for ${scenario.id}.`);
      }
      if (sample.rank !== null && (!Number.isInteger(sample.rank) || (sample.rank as number) < 0)) {
        throw new Error(`shopping_env returned an invalid rank for ${scenario.id}.`);
      }
      if (typeof sample.ocr_text !== "string") {
        throw new Error(`shopping_env returned no OCR context for ${scenario.id}.`);
      }
      samples.push({
        category: sample.category,
        item_id: sample.item_id,
        rank: sample.rank as number | null,
        sample_index: sample.sample_index as number,
      });
    }
    validateSampleSummaries(samples, scenario, config);
    return samples;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Verify the durable market publication for one app task. */
export async function verifyBackendEnvMarketArtifact(
  config: BackendEnvTestConfig,
  scenario: BackendEnvScenario,
  task: TaskState["tasks"][number],
  samples: readonly BackendEnvSampleSummary[],
): Promise<BackendEnvArtifactSummary> {
  const artifactDirectory = path.resolve(config.cwd, config.dataDirectory, "market-criteria", task.route.node_id);
  const marketPath = path.join(artifactDirectory, "market.json");
  let market: Record<string, unknown>;
  try {
    market = JSON.parse(await readFile(marketPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Market artifact is missing or invalid for ${scenario.id}: ${marketPath} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!market || typeof market !== "object" || Array.isArray(market)) {
    throw new Error(`Market artifact for ${scenario.id} is not a JSON object.`);
  }
  const node = market.node as Record<string, unknown> | undefined;
  const expectedIds = samples.map((sample) => sample.item_id);
  if (!node || node.id !== task.route.node_id || node.name !== task.route.node_name || !isDeepStrictEqual(node.path, routePath(task.route))) {
    throw new Error(`Market artifact node does not match the active route for ${scenario.id}.`);
  }
  if (market.dataset_category !== scenario.datasetCategory) {
    throw new Error(`Market artifact category for ${scenario.id} is '${String(market.dataset_category)}', expected '${scenario.datasetCategory}'.`);
  }
  if (market.traversed_product_count !== config.maxDistinctProducts) {
    throw new Error(`Market artifact for ${scenario.id} traversed ${String(market.traversed_product_count)} products; expected ${config.maxDistinctProducts}.`);
  }
  if (!Array.isArray(market.product_ids) || !isDeepStrictEqual(market.product_ids, expectedIds)) {
    throw new Error(`Market artifact product_ids do not match the deterministic preflight for ${scenario.id}.`);
  }
  if (!Array.isArray(market.criteria) || !Array.isArray(market.attributes)) {
    throw new Error(`Market artifact for ${scenario.id} is missing criteria or attributes arrays.`);
  }
  const productsDirectory = path.join(artifactDirectory, "products");
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = await readdir(productsDirectory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Product artifact directory is missing or invalid for ${scenario.id}: ${productsDirectory} (${error instanceof Error ? error.message : String(error)})`);
  }
  const expectedFiles = new Set(expectedIds.map((itemId) => `${itemId}.json`));
  if (entries.length !== expectedFiles.size || entries.some((entry) => !entry.isFile() || !expectedFiles.has(entry.name))) {
    throw new Error(`Product artifact directory for ${scenario.id} must contain exactly the ${config.maxDistinctProducts} selected product JSON files.`);
  }
  for (const itemId of expectedIds) {
    const productPath = path.join(productsDirectory, `${itemId}.json`);
    let product: Record<string, unknown>;
    try {
      product = JSON.parse(await readFile(productPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Product artifact is missing or invalid for ${scenario.id}/${itemId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!product || product.item_id !== itemId || product.dataset_category !== scenario.datasetCategory) {
      throw new Error(`Product artifact does not match ${scenario.id}/${itemId}.`);
    }
  }
  return { node_id: task.route.node_id, marketPath, productIds: expectedIds };
}

function validateFinalState(state: TaskState, scenarios: readonly BackendEnvScenario[], taskIds: readonly string[]): void {
  if (state.tasks.length !== scenarios.length) {
    throw new Error(`Backend env final state expected exactly ${scenarios.length} tasks; got ${state.tasks.length}.`);
  }
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error("Backend env scenarios did not receive independent task IDs.");
  }
  for (const scenario of scenarios) {
    const matches = state.tasks.filter((task) => acceptedRouteForTask(task, scenario));
    if (matches.length !== 1) {
      throw new Error(`Backend env final state expected one matching task for ${scenario.id}, got ${matches.length}.`);
    }
  }
  const activeTask = state.tasks.find((task) => task.task_id === state.active_task_id);
  if (!activeTask || !acceptedRouteForTask(activeTask, scenarios[scenarios.length - 1]!)) {
    throw new Error("Backend env final active task is not the third category.");
  }
}

/** Format one turn as a CI-friendly JSON Lines record without OCR content. */
export function formatBackendEnvTestTurn(turn: BackendEnvTestTurn): string {
  return JSON.stringify({
    turn: turn.turn,
    scenario: turn.scenario,
    assistant_final: turn.assistant,
    task_state: turn.taskState,
    env_samples: turn.envSamples.map(({ category, item_id, rank, sample_index }) => ({ category, item_id, rank, sample_index })),
  });
}

/**
 * Execute the fixed backend-env workflow through one app instance. The real
 * probe runs twice per category so cached artifacts are checked against a
 * fresh deterministic sample run; tests can inject a probe and fake app.
 */
export async function runBackendEnvTest(
  app: BackendEnvTestApp,
  options: RunBackendEnvTestOptions = {},
): Promise<BackendEnvTestResult> {
  const scenarios = options.scenarios ?? BACKEND_ENV_TEST_SCENARIOS;
  if (!scenarios.length) throw new Error("Backend env test requires at least one scenario.");
  if (!Number.isInteger(app.config.maxDistinctProducts) || app.config.maxDistinctProducts <= 0) {
    throw new Error("Backend env test requires a positive maxDistinctProducts config.");
  }
  const probe = options.probe ?? probeBackendEnv;
  const turns: BackendEnvTestTurn[] = [];
  const taskIds: string[] = [];

  for (const [index, scenario] of scenarios.entries()) {
    const firstProbe = [...await probe(scenario, app.config)];
    const secondProbe = [...await probe(scenario, app.config)];
    validateSampleSummaries(firstProbe, scenario, app.config);
    validateSampleSummaries(secondProbe, scenario, app.config);
    if (!isDeepStrictEqual(firstProbe, secondProbe)) {
      throw new Error(`Backend env preflight is not deterministic for ${scenario.id}.`);
    }

    const messageCountBefore = app.getMessages().length;
    await app.prompt(scenario.prompt);
    const messagesAfter = app.getMessages();
    const newMessages = messagesAfter.length > messageCountBefore
      ? messagesAfter.slice(messageCountBefore)
      : messagesAfter;
    const assistant = finalAssistantText(newMessages);
    if (!assistant.trim()) throw new Error(`Backend env scenario ${scenario.id} produced no final assistant text.`);
    const taskState = snapshotState(await app.getTaskState());
    const task = taskForScenario(taskState, scenario);
    if (taskIds.includes(task.task_id)) {
      throw new Error(`Backend env scenario ${scenario.id} reused a previous task ID.`);
    }
    taskIds.push(task.task_id);
    await verifyBackendEnvMarketArtifact(app.config, scenario, task, firstProbe);
    const turn: BackendEnvTestTurn = {
      turn: index + 1,
      scenario: scenario.id,
      assistant,
      taskState,
      envSamples: firstProbe,
    };
    turns.push(turn);
    await options.onTurn?.(turn, scenarios.length);
  }

  const finalTaskState = turns[turns.length - 1]!.taskState;
  validateFinalState(finalTaskState, scenarios, taskIds);
  return { turns, finalTaskState };
}
