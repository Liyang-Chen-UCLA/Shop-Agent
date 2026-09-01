import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  containsPreferenceValue,
  formatMultiTurnTestTurn,
  MULTI_TURN_TEST_INPUTS,
  runMultiTurnTest,
  type MultiTurnTestApp,
} from "../src/multi-turn-test.ts";
import type { TaskState } from "../src/framework/types.ts";

const route = (node_id: string, node_name: string, node_path: string) => ({ node_id, node_name, node_path });

function state(routeValue: ReturnType<typeof route>, preference: Record<string, unknown>): TaskState {
  return {
    schema_version: 1,
    active_task_id: "phone-task",
    tasks: [{
      task_id: "phone-task",
      product: routeValue.node_name,
      preference: preference as TaskState["tasks"][number]["preference"],
      route: routeValue,
    }],
  };
}

class FakeShopAgent implements MultiTurnTestApp {
  readonly prompts: string[] = [];
  private readonly messages: AgentMessage[] = [];
  readonly states: TaskState[] = [
    state(route("267", "手机", "电子产品 > 通讯 > 电话 > 手机"), {
      price_ceiling: "5000元",
      allowed_makers: ["苹果", "小米"],
    }),
    state(route("267", "手机", "电子产品 > 通讯 > 电话 > 手机"), {
      price_ceiling: "6000元",
      allowed_makers: ["苹果", "小米"],
    }),
    state(route("543514", "无锁手机", "电子产品 > 通讯 > 电话 > 手机 > 无锁手机"), {
      price_ceiling: "6000元",
      allowed_makers: ["苹果", "小米"],
    }),
  ];
  private stateIndex = 0;

  async prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.messages.push({ role: "user", content: [{ type: "text", text }] } as never);
    this.messages.push({
      role: "assistant",
      content: [{ type: "text", text: `fake assistant turn ${this.prompts.length}` }],
    } as never);
  }

  getMessages(): readonly AgentMessage[] {
    return this.messages;
  }

  async getTaskState(): Promise<TaskState> {
    const value = this.states[this.stateIndex++];
    if (!value) throw new Error("fake state exhausted");
    return value;
  }
}

test("runs the fixed scenario through one app and reports each final turn", async () => {
  const app = new FakeShopAgent();
  const output: string[] = [];
  const result = await runMultiTurnTest(app, {
    onTurn: (turn) => output.push(formatMultiTurnTestTurn(turn)),
  });

  assert.deepEqual(app.prompts, [...MULTI_TURN_TEST_INPUTS]);
  assert.equal(result.turns.length, 3);
  assert.equal(output.length, 3);
  assert.equal(result.turns[0]?.assistant, "fake assistant turn 1");
  assert.equal(result.turns[2]?.taskState.tasks[0]?.route.node_id, "543514");

  const record = JSON.parse(output[1]!) as {
    turn: number;
    user_input: string;
    assistant_final: string;
    task_state: TaskState;
  };
  assert.equal(record.turn, 2);
  assert.equal(record.user_input, MULTI_TURN_TEST_INPUTS[1]);
  assert.equal(record.assistant_final, "fake assistant turn 2");
  assert.deepEqual(record.task_state.tasks[0]?.preference, {
    price_ceiling: "6000元",
    allowed_makers: ["苹果", "小米"],
  });
});

test("propagates a failed prompt so the CLI can exit non-zero", async () => {
  const app = new FakeShopAgent();
  app.prompt = async () => { throw new Error("offline prompt failure"); };
  await assert.rejects(() => runMultiTurnTest(app, { inputs: ["test input"] }), /offline prompt failure/);
});

test("rejects the fixed scenario when the second turn keeps the old preference value", async () => {
  const app = new FakeShopAgent();
  app.states[1]!.tasks[0]!.preference = {
    price_ceiling: "5000元",
    allowed_makers: ["苹果", "小米"],
  };
  await assert.rejects(() => runMultiTurnTest(app), /6000|old value 5000/);
});

test("matches complete numeric tokens in preference strings", () => {
  assert.equal(containsPreferenceValue({ budget: "5,000.50元" }, 5_000.5), true);
  assert.equal(containsPreferenceValue({ budget: "15000元" }, 5_000), false);
});
