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

const cwd = path.resolve(import.meta.dirname, "..");

test("loads project config and OpenCode Go model catalog", async () => {
  const config = await loadConfig(cwd);
  assert.equal(config.orchestrator, "orchestrator");
  assert.equal(config.agents.find((agent) => agent.id === "delegate")?.role, "subagent");
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

test("creates an interactive orchestrator with only the delegation tool", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shop-agent-app-test-"));
  try {
    const app = await createShopAgent({
      cwd,
      skipAuthCheck: true,
      config: { dataDirectory: directory },
    });
    assert.deepEqual(app.agent.state.tools.map((tool) => tool.name), ["delegate_agent"]);
    const result = await app.agent.state.tools[0].execute("list-call", { action: "list" });
    const agents = JSON.parse((result.content[0] as { text: string }).text) as { id: string }[];
    assert.deepEqual(agents.map((agent) => agent.id), ["delegate"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
