import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { messageText } from "./framework/content.ts";
import type { TaskState } from "./framework/types.ts";

/**
 * The small part of ShopAgent used by the deterministic multi-turn runner.
 * Keeping this interface structural makes the runner usable with a fake app
 * in offline node:test tests.
 */
export type MultiTurnTestApp = {
  prompt(text: string): Promise<void>;
  getMessages(): readonly AgentMessage[];
  getTaskState(): Promise<TaskState>;
};

/**
 * A three-turn conversation that exercises the canonical task lifecycle:
 * create a phone task, change a preference, then refine its route.
 *
 * The prompts describe the intended semantics, while validation below only
 * compares preference objects as a whole. It intentionally does not assume
 * a particular natural-language preference key such as "budget" or "brand".
 */
export const MULTI_TURN_TEST_INPUTS = [
  "我想分析“手机”这个品类；不要选择合约手机、无锁手机或预付费手机子类，就按“手机”这一分类创建任务。预算上限为 5000 元，品牌可选苹果或小米。",
  "修改当前手机任务的偏好：把预算上限改为 6000 元，其他偏好保持不变；不要更换品类或路由。",
  "将当前手机任务细分到直接子分类“无锁手机”，确认选择这个子分类；保持刚才的所有偏好不变。",
] as const;

export type MultiTurnTestTurn = {
  turn: number;
  input: string;
  assistant: string;
  taskState: TaskState;
};

export type MultiTurnTestResult = {
  turns: MultiTurnTestTurn[];
};

export type RunMultiTurnTestOptions = {
  /** Override the prompts for a focused unit test. Custom inputs skip scenario validation by default. */
  inputs?: readonly string[];
  /** Called once after each prompt has produced its final assistant text and task state. */
  onTurn?: (turn: MultiTurnTestTurn, totalTurns: number) => void | Promise<void>;
  /** Validate the built-in create → update → refine phone scenario. */
  validateScenario?: boolean;
};

const PHONE_ROUTE = {
  node_id: "267",
  node_name: "手机",
  node_path: "电子产品 > 通讯 > 电话 > 手机",
} as const;

const UNLOCKED_PHONE_ROUTE = {
  node_id: "543514",
  node_name: "无锁手机",
  node_path: "电子产品 > 通讯 > 电话 > 手机 > 无锁手机",
} as const;

function finalAssistantText(messages: readonly AgentMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = messageText(message);
    if (text.trim()) return text;
  }
  return "";
}

/** Search preference values without depending on the model's chosen key names. */
export function containsPreferenceValue(value: unknown, expected: string | number | boolean): boolean {
  if (typeof value === "string" && typeof expected === "number") {
    const numberTokens = value.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [];
    if (numberTokens.some((token) => Number(token.replace(/,/g, "")) === expected)) return true;
  }
  if (Object.is(value, expected)) return true;
  if (Array.isArray(value)) return value.some((item) => containsPreferenceValue(item, expected));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some((item) => containsPreferenceValue(item, expected));
}

function snapshotState(state: TaskState): TaskState {
  // Task state is a JSON contract. Snapshot it so a fake app that reuses a
  // mutable object cannot change the state captured for an earlier turn.
  return JSON.parse(JSON.stringify(state)) as TaskState;
}

function onlyTask(turn: MultiTurnTestTurn): TaskState["tasks"][number] {
  if (turn.taskState.tasks.length !== 1) {
    throw new Error(`Multi-turn test turn ${turn.turn} must contain exactly one task; got ${turn.taskState.tasks.length}.`);
  }
  const task = turn.taskState.tasks[0];
  if (!task || !turn.taskState.active_task_id) {
    throw new Error(`Multi-turn test turn ${turn.turn} must have an active task.`);
  }
  if (task.task_id !== turn.taskState.active_task_id) {
    throw new Error(`Multi-turn test turn ${turn.turn} active_task_id does not match its only task.`);
  }
  return task;
}

function sameRoute(actual: TaskState["tasks"][number]["route"], expected: typeof PHONE_ROUTE, label: string): void;
function sameRoute(actual: TaskState["tasks"][number]["route"], expected: typeof UNLOCKED_PHONE_ROUTE, label: string): void;
function sameRoute(
  actual: TaskState["tasks"][number]["route"],
  expected: typeof PHONE_ROUTE | typeof UNLOCKED_PHONE_ROUTE,
  label: string,
): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} route mismatch. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

/**
 * Check the state transitions required by the built-in scenario.
 * Preference keys are deliberately opaque: only the value change on turn 2
 * and preservation during route refinement on turn 3 are significant.
 */
export function validateMultiTurnTestScenario(turns: readonly MultiTurnTestTurn[]): void {
  if (turns.length !== MULTI_TURN_TEST_INPUTS.length) {
    throw new Error(`Multi-turn test expected ${MULTI_TURN_TEST_INPUTS.length} turns; got ${turns.length}.`);
  }

  const [created, preferenceUpdated, routeRefined] = turns;
  const createdTask = onlyTask(created);
  sameRoute(createdTask.route, PHONE_ROUTE, "Turn 1");

  const updatedTask = onlyTask(preferenceUpdated);
  if (updatedTask.task_id !== createdTask.task_id) {
    throw new Error("Turn 2 changed task identity; preference updates must keep the same task.");
  }
  sameRoute(updatedTask.route, PHONE_ROUTE, "Turn 2");
  if (!containsPreferenceValue(createdTask.preference, 5_000)) {
    throw new Error("Turn 1 preference must contain the value 5000.");
  }
  if (!containsPreferenceValue(createdTask.preference, "苹果") || !containsPreferenceValue(createdTask.preference, "小米")) {
    throw new Error("Turn 1 preference must contain both 苹果 and 小米.");
  }
  if (!containsPreferenceValue(updatedTask.preference, 6_000)) {
    throw new Error("Turn 2 preference must contain the updated value 6000.");
  }
  if (containsPreferenceValue(updatedTask.preference, 5_000)) {
    throw new Error("Turn 2 preference must not contain the old value 5000.");
  }
  if (!containsPreferenceValue(updatedTask.preference, "苹果") || !containsPreferenceValue(updatedTask.preference, "小米")) {
    throw new Error("Turn 2 preference must retain both 苹果 and 小米.");
  }
  if (isDeepStrictEqual(updatedTask.preference, createdTask.preference)) {
    throw new Error("Turn 2 did not change the task preference.");
  }

  const refinedTask = onlyTask(routeRefined);
  if (refinedTask.task_id !== createdTask.task_id) {
    throw new Error("Turn 3 changed task identity; route refinement must keep the same task.");
  }
  sameRoute(refinedTask.route, UNLOCKED_PHONE_ROUTE, "Turn 3");
  if (!isDeepStrictEqual(refinedTask.preference, updatedTask.preference)) {
    throw new Error("Turn 3 changed preferences while refining the route.");
  }
}

/**
 * Format one turn as a JSON Lines record. Each line is both easy to inspect by
 * hand and straightforward for CI to parse without guessing where a state
 * document ends.
 */
export function formatMultiTurnTestTurn(turn: MultiTurnTestTurn): string {
  return JSON.stringify({
    turn: turn.turn,
    user_input: turn.input,
    assistant_final: turn.assistant,
    task_state: turn.taskState,
  });
}

/**
 * Run the fixed conversation through one app instance.
 *
 * No app is created here: callers choose the real createShopAgent result for
 * the CLI or a fake app for offline tests. Any prompt/state/extraction error
 * is allowed to reject so the CLI's top-level handler can set a non-zero exit
 * code.
 */
export async function runMultiTurnTest(
  app: MultiTurnTestApp,
  options: RunMultiTurnTestOptions = {},
): Promise<MultiTurnTestResult> {
  const inputs = options.inputs ?? MULTI_TURN_TEST_INPUTS;
  if (!inputs.length) throw new Error("Multi-turn test requires at least one input.");
  const shouldValidate = options.validateScenario ?? options.inputs === undefined;
  const turns: MultiTurnTestTurn[] = [];

  for (const [index, input] of inputs.entries()) {
    const messageCountBefore = app.getMessages().length;
    await app.prompt(input);
    const messagesAfter = app.getMessages();
    const newMessages = messagesAfter.length > messageCountBefore
      ? messagesAfter.slice(messageCountBefore)
      : messagesAfter;
    const assistant = finalAssistantText(newMessages);
    if (!assistant.trim()) {
      throw new Error(`Multi-turn test turn ${index + 1} produced no final assistant text.`);
    }
    const taskState = snapshotState(await app.getTaskState());
    const turn: MultiTurnTestTurn = {
      turn: index + 1,
      input,
      assistant,
      taskState,
    };
    turns.push(turn);
    await options.onTurn?.(turn, inputs.length);
  }

  if (shouldValidate) validateMultiTurnTestScenario(turns);
  return { turns };
}
