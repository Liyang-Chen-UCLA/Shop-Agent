import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/framework/config.ts";
import { createModelRuntime } from "../src/framework/model-runtime.ts";
import { createPythonAgentTools, discoverPythonTools } from "../src/framework/python-tools.ts";
import { validateJsonSchema } from "../src/framework/schema.ts";
import { SessionStore } from "../src/framework/session-store.ts";
import { createShopAgent } from "../src/framework/shop-agent.ts";
import { renderRunCard, renderTaskState, summarizeValue } from "../src/tui/presentation.ts";

const cwd = path.resolve(import.meta.dirname, "..");

test("loads project config and OpenCode Go model catalog", async () => {
  const config = await loadConfig(cwd);
  assert.equal(config.orchestrator, "orchestrator");
  assert.equal(config.agents.find((agent) => agent.id === "delegate")?.role, "subagent");
  assert.deepEqual(config.agents.find((agent) => agent.id === "route_agent")?.tools, [
    "taxonomy_search_nodes",
    "taxonomy_get_nodes",
    "taxonomy_get_children",
  ]);
  assert.match(config.agents[0].systemPrompt, /orchestrator/i);

  const runtime = createModelRuntime();
  const model = runtime.getModel("muse-spark-1.2-contributor");
  assert.equal(model.provider, "opencode-go");
  runtime.ensureThinking(model, "medium");
});

test("validates the JSON Schema subset used by tool manifests", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, count: { type: "integer" } },
    required: ["name"],
    additionalProperties: false,
  };
  assert.deepEqual(validateJsonSchema(schema, { name: "item", count: 2 }), { valid: true });
  assert.equal(validateJsonSchema(schema, { count: 2 }).valid, false);
  assert.equal(validateJsonSchema(schema, { name: "item", extra: true }).valid, false);
});

test("formats safe TUI summaries, run cards, and task state", () => {
  assert.equal(
    summarizeValue({ query: "手机", authorization: "Bearer secret", nested: { apiToken: "hidden" } }),
    '{"query":"手机","authorization":"[REDACTED]","nested":{"apiToken":"[REDACTED]"}}',
  );
  assert.equal(summarizeValue({ text: '{"password":"nested-secret"}' }), '{"text":{"password":"[REDACTED]"}}');
  const card = renderRunCard({
    id: "12345678-aaaa-bbbb-cccc-dddddddddddd",
    agent: "route_agent",
    task: "定位无锁手机分类",
    state: "completed",
    startedAt: "2026-08-29T00:00:00.000Z",
    endedAt: "2026-08-29T00:00:01.500Z",
    events: [{
      timestamp: "2026-08-29T00:00:01.000Z",
      attempt: 1,
      type: "tool_start",
      tool: "taxonomy_search_nodes",
      args: { queries: ["手机"], api_key: "do-not-render" },
    }],
  });
  assert.match(card, /route\\_agent/);
  assert.match(card, /taxonomy_search_nodes/);
  assert.match(card, /\[REDACTED\]/);
  assert.doesNotMatch(card, /do-not-render/);

  const state = renderTaskState({
    schema_version: 1,
    active_task_id: "task-1",
    tasks: [{
      task_id: "task-1",
      product: "无锁手机",
      preference: { 最高价格: 6000 },
      route: { node_id: "543514", node_name: "无锁手机", node_path: "电子产品 > 手机 > 无锁手机" },
    }],
  }, false);
  assert.match(state, /Active task/);
  assert.match(state, /无锁手机/);
  assert.match(state, /最高价格/);
});

test("runs a manifest-based Python tool without leaking OPENCODE_API_KEY", async () => {
  const definitions = await discoverPythonTools(cwd, ["tests/fixtures"]);
  const tools = createPythonAgentTools(definitions, ["echo_python"], {
    executable: "D:\\App\\miniforge3\\envs\\shop-agent\\python.exe",
    timeoutMs: 10_000,
    envAllowlist: [],
  });
  const previous = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = "must-not-reach-python";
  try {
    const result = await tools[0].execute("call-1", { value: "hello" });
    assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text), {
      value: "hello",
      hasOpenCodeKey: false,
    });
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previous;
  }
});

test("persists and resumes project sessions as JSONL", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shop-agent-test-"));
  try {
    const store = new SessionStore(directory);
    const session = await store.create("muse-spark-1.2-contributor", "medium");
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "Find a laptop" }], timestamp: Date.now() },
    ];
    await store.appendMessages(session, messages);
    const loaded = await store.load(session.metadata.id.slice(0, 8));
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.metadata.title, "Find a laptop");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("queries canonical taxonomy nodes and direct children in batches", async () => {
  const definitions = await discoverPythonTools(cwd, ["shop/tools"]);
  const tools = createPythonAgentTools(
    definitions,
    ["taxonomy_search_nodes", "taxonomy_get_nodes", "taxonomy_get_children"],
    {
      executable: "D:\\App\\miniforge3\\envs\\shop-agent\\python.exe",
      timeoutMs: 10_000,
      envAllowlist: [],
    },
  );
  const search = await tools[0].execute("taxonomy-search", { queries: ["手机", "耳机"], limit: 3 });
  const searchValue = JSON.parse((search.content[0] as { text: string }).text) as {
    results: { query: string; matches: { node_id: string }[] }[];
  };
  assert.equal(searchValue.results[0].matches[0].node_id, "267");
  assert.equal(searchValue.results[1].matches[0].node_id, "505771");

  const nodes = await tools[1].execute("taxonomy-get", { node_ids: ["267", "543514", "missing"] });
  const nodeValue = JSON.parse((nodes.content[0] as { text: string }).text) as {
    nodes: { node_id: string }[];
    missing_node_ids: string[];
  };
  assert.deepEqual(nodeValue.nodes.map((node) => node.node_id), ["267", "543514"]);
  assert.deepEqual(nodeValue.missing_node_ids, ["missing"]);

  const children = await tools[2].execute("taxonomy-children", { node_ids: ["267", "543514"] });
  const childValue = JSON.parse((children.content[0] as { text: string }).text) as {
    results: { node_id: string; children: { node_id: string }[] }[];
  };
  assert.deepEqual(childValue.results[0].children.map((node) => node.node_id).sort(), ["543512", "543513", "543514"]);
  assert.deepEqual(childValue.results[1].children, []);
});

test("persists minimal task state per trusted session with LangGraph SQLite", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shop-agent-state-test-"));
  try {
    const definitions = await discoverPythonTools(cwd, ["shop/tools"]);
    const config = {
      executable: "D:\\App\\miniforge3\\envs\\shop-agent\\python.exe",
      timeoutMs: 30_000,
      envAllowlist: [],
    };
    const context = (sessionId: string) => ({ sessionId, dataDirectory: directory });
    const sessionATools = createPythonAgentTools(
      definitions,
      ["task_state_get", "task_state_upsert"],
      config,
      () => context("session-a"),
    );
    const empty = await sessionATools[0].execute("state-empty", {});
    assert.deepEqual(JSON.parse((empty.content[0] as { text: string }).text).state, {
      schema_version: 1,
      active_task_id: null,
      tasks: [],
    });

    const created = await sessionATools[1].execute("state-create", {
      product: "手机",
      preference: { 品牌: ["Apple", "小米"], 最高价格: 5000 },
      route: { node_id: "267", node_name: "手机", node_path: "电子产品 > 通讯 > 电话 > 手机" },
    });
    const createdValue = JSON.parse((created.content[0] as { text: string }).text) as {
      action: string;
      task: { task_id: string };
    };
    assert.equal(createdValue.action, "created");

    const refined = await sessionATools[1].execute("state-refine", {
      task_id: createdValue.task.task_id,
      product: "无锁手机",
      preference: { 最高价格: 6000 },
      remove_preference_keys: ["品牌"],
      route: {
        node_id: "543514",
        node_name: "无锁手机",
        node_path: "电子产品 > 通讯 > 电话 > 手机 > 无锁手机",
      },
    });
    const refinedValue = JSON.parse((refined.content[0] as { text: string }).text) as {
      action: string;
      task: { task_id: string; product: string; preference: Record<string, unknown>; route: { node_id: string } };
      state: { tasks: unknown[] };
    };
    assert.equal(refinedValue.action, "updated");
    assert.equal(refinedValue.task.task_id, createdValue.task.task_id);
    assert.equal(refinedValue.task.product, "无锁手机");
    assert.deepEqual(refinedValue.task.preference, { 最高价格: 6000 });
    assert.equal(refinedValue.task.route.node_id, "543514");
    assert.equal(refinedValue.state.tasks.length, 1);

    const sessionBTools = createPythonAgentTools(
      definitions,
      ["task_state_get"],
      config,
      () => context("session-b"),
    );
    const isolated = await sessionBTools[0].execute("state-isolated", {});
    assert.deepEqual(JSON.parse((isolated.content[0] as { text: string }).text).state.tasks, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("creates an interactive orchestrator with state tools and focused subagents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shop-agent-app-test-"));
  try {
    const app = await createShopAgent({
      cwd,
      skipAuthCheck: true,
      config: { dataDirectory: directory },
    });
    assert.deepEqual(app.agent.state.tools.map((tool) => tool.name), [
      "task_state_get",
      "task_state_upsert",
      "task_state_set_active",
      "task_state_delete",
      "delegate_agent",
    ]);
    const result = await app.agent.state.tools[4].execute("list-call", { action: "list" });
    const agents = JSON.parse((result.content[0] as { text: string }).text) as { id: string }[];
    assert.deepEqual(agents.map((agent) => agent.id), ["route_agent", "product_analyst", "delegate"]);

    const state = await app.getTaskState();
    assert.deepEqual(state.tasks, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
