import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/framework/config.ts";
import { createModelRuntime } from "../src/framework/model-runtime.ts";
import { SubagentManager } from "../src/framework/subagents/manager.ts";
import { createShopAgent } from "../src/framework/shop-agent.ts";
import { createTracing, mapCost, mapUsage, sanitizeTracePayload, traceTools } from "../src/framework/tracing/index.ts";
import type {
  ObservationAttributes,
  ObservationType,
  TraceContext,
  TraceObservation,
  Tracing,
} from "../src/framework/tracing/index.ts";

type Recorded = {
  name: string;
  type: ObservationType;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  sessionId?: string;
  attributes: ObservationAttributes;
  ended: boolean;
  failures: { message: string; aborted: boolean }[];
};

class RecordingHandle implements TraceObservation {
  readonly record: Recorded;
  constructor(record: Recorded) { this.record = record; }
  get traceId() { return this.record.traceId; }
  get spanId() { return this.record.spanId; }
  update(attributes: ObservationAttributes) { this.record.attributes = { ...this.record.attributes, ...attributes }; }
  fail(error: unknown, aborted = false) { this.record.failures.push({ message: String(error), aborted }); }
  end() { this.record.ended = true; }
}

class RecordingTracing implements Tracing {
  readonly enabled = true;
  readonly records: Recorded[] = [];
  readonly storage = new AsyncLocalStorage<RecordingHandle>();
  private sequence = 0;
  throwOnFlush = false;
  current() { return this.storage.getStore(); }
  context(sessionId: string) {
    const current = this.current();
    return current ? { traceId: current.traceId, parentSpanId: current.spanId, sessionId } : undefined;
  }
  startObservation(name: string, type: ObservationType, attributes: ObservationAttributes) {
    const parent = this.current();
    const record: Recorded = {
      name, type,
      traceId: parent?.traceId ?? `trace-${++this.sequence}`,
      spanId: `span-${++this.sequence}`,
      parentSpanId: parent?.spanId,
      attributes,
      ended: false,
      failures: [],
    };
    this.records.push(record);
    return new RecordingHandle(record);
  }
  runInScope<T>(observation: TraceObservation | undefined, fn: () => T): T {
    return observation instanceof RecordingHandle ? this.storage.run(observation, fn) : fn();
  }
  async withObservation<T>(name: string, type: ObservationType, attributes: ObservationAttributes, fn: (observation: TraceObservation | undefined) => T | Promise<T>, sessionId?: string): Promise<T> {
    const handle = this.startObservation(name, type, attributes);
    handle.record.sessionId = sessionId;
    try { return await this.storage.run(handle, () => fn(handle)); }
    catch (error) { handle.fail(error); throw error; }
    finally { handle.end(); }
  }
  async withRemoteObservation<T>(name: string, type: ObservationType, attributes: ObservationAttributes, parent: TraceContext, fn: (observation: TraceObservation | undefined) => T | Promise<T>): Promise<T> {
    const record: Recorded = {
      name, type, traceId: parent.traceId, spanId: `span-${++this.sequence}`, parentSpanId: parent.parentSpanId,
      sessionId: parent.sessionId, attributes, ended: false, failures: [],
    };
    this.records.push(record);
    const handle = new RecordingHandle(record);
    try { return await this.storage.run(handle, () => fn(handle)); }
    catch (error) { handle.fail(error); throw error; }
    finally { handle.end(); }
  }
  async flush() { if (this.throwOnFlush) throw new Error("exporter unavailable"); }
  async shutdown() {}
}

const usage = {
  input: 100,
  output: 40,
  cacheRead: 25,
  cacheWrite: 5,
  reasoning: 12,
  totalTokens: 170,
  cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

test("maps Pi usage into exclusive Langfuse buckets and preserves exact cost", () => {
  assert.deepEqual(mapUsage(usage), {
    input: 100,
    output: 28,
    cache_read_input_tokens: 25,
    cache_creation_input_tokens: 5,
    output_reasoning_tokens: 12,
    total: 170,
  });
  const cost = mapCost(usage);
  assert.deepEqual({ ...cost, output: undefined, output_reasoning_tokens: undefined }, {
    input: 0.1,
    output: undefined,
    output_reasoning_tokens: undefined,
    cache_read_input_tokens: 0.01,
    cache_creation_input_tokens: 0.02,
    total: 0.33,
  });
  assert.ok(Math.abs((cost.output ?? 0) - 0.14) < 1e-12);
  assert.ok(Math.abs((cost.output_reasoning_tokens ?? 0) - 0.06) < 1e-12);
  assert.equal((cost.output ?? 0) + (cost.output_reasoning_tokens ?? 0), usage.cost.output);
});

test("sanitizes secrets, raw reasoning, circular values, and oversized payloads", () => {
  const circular: Record<string, unknown> = { apiToken: "top-secret", authorization: "Bearer visible-secret", thinking: "raw chain" };
  circular.self = circular;
  circular.large = "x".repeat(25_000);
  const sanitized = sanitizeTracePayload(circular);
  const text = JSON.stringify(sanitized);
  assert.doesNotMatch(text, /top-secret|visible-secret|raw chain/);
  assert.match(text, /REDACTED/);
  assert.match(text, /originalLength/);
  assert.match(text, /sha256/);
});

test("traces every real model request without uploading thinking", async () => {
  const tracing = new RecordingTracing();
  const runtime = createModelRuntime(tracing);
  const model = runtime.getModel("hy3");
  runtime.models.streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "private-thought" }, { type: "text", text: "answer" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    } as never;
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message } as never);
      stream.push({ type: "thinking_delta", contentIndex: 0, delta: "private", partial: message } as never);
      stream.push({ type: "text_delta", contentIndex: 1, delta: "answer", partial: message } as never);
      stream.push({ type: "done", reason: "stop", message } as never);
    });
    return stream;
  };

  await tracing.withObservation("shop-turn", "agent", { input: "hello" }, async () => {
    const stream = runtime.streamSimple(model, {
      systemPrompt: "system",
      messages: [{ role: "user", content: "Authorization: Bearer abcdefghijklmnop", timestamp: Date.now() }],
    }, { sessionId: "session-a", reasoning: "high" });
    await stream.result();
  }, "session-a");

  const generation = tracing.records.find((record) => record.type === "generation")!;
  assert.equal(generation.parentSpanId, tracing.records[0].spanId);
  assert.equal(generation.attributes.model, model.id);
  assert.deepEqual(generation.attributes.usageDetails, mapUsage(usage));
  assert.deepEqual(generation.attributes.costDetails, mapCost(usage));
  assert.ok(generation.attributes.completionStartTime instanceof Date);
  assert.doesNotMatch(JSON.stringify(generation.attributes), /private-thought|abcdefghijklmnop/);
  assert.equal(generation.ended, true);
});

test("delegate_agent run is represented only by its agent while list/get remain tools", async () => {
  const tracing = new RecordingTracing();
  const calls: string[] = [];
  const delegate = {
    name: "delegate_agent",
    async execute(_id: string, args: { action: string }) { calls.push(args.action); return { content: [] }; },
  } as any;
  const ordinary = {
    name: "taxonomy_get_nodes",
    async execute() { return { content: [{ type: "text", text: "ok" }] }; },
  } as any;
  const [tool, ordinaryTool] = traceTools([delegate, ordinary], tracing);
  await tracing.withObservation("shop-turn", "agent", {}, async () => {
    await tool.execute("list", { action: "list" });
    await tool.execute("run", { action: "run" });
    await ordinaryTool.execute("ordinary", { node_ids: ["267"] });
  });
  assert.deepEqual(calls, ["list", "run"]);
  const root = tracing.records[0];
  const tools = tracing.records.filter((record) => record.type === "tool");
  assert.deepEqual(tools.map((record) => record.name), ["delegate-agent", "taxonomy-get-nodes"]);
  assert.ok(tools.every((record) => record.parentSpanId === root.spanId));
});

test("model abort is distinct from an exporter or provider error", async () => {
  const tracing = new RecordingTracing();
  const runtime = createModelRuntime(tracing);
  const model = runtime.getModel("hy3");
  runtime.models.streamSimple = () => {
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { ...usage, input: 0, output: 0, reasoning: 0, totalTokens: 0 },
      stopReason: "aborted", errorMessage: "Request aborted", timestamp: Date.now(),
    } as never;
    queueMicrotask(() => stream.push({ type: "error", reason: "aborted", error: message } as never));
    return stream;
  };
  await tracing.withObservation("shop-turn", "agent", {}, async () => {
    await runtime.streamSimple(model, { messages: [] }).result();
  });
  const generation = tracing.records.find((record) => record.type === "generation")!;
  assert.equal(generation.attributes.level, "WARNING");
  assert.equal((generation.attributes.metadata as any).outcome, "aborted");
  assert.deepEqual(generation.failures.map((failure) => failure.aborted), [true]);
});

test("subagent retry uses one logical agent and passes one trace to every attempt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shop-agent-tracing-retry-"));
  try {
    const config = await loadConfig(path.resolve(import.meta.dirname, ".."), undefined, { paths: { runtimeData: directory } });
    const tracing = new RecordingTracing();
    const manager = new SubagentManager(config, new Map(), undefined, tracing);
    const profile = { ...config.agents.find((item) => item.id === "delegate")!, maxRetries: 1 };
    const requests: Array<{ attempt: number; traceContext?: TraceContext }> = [];
    (manager as any).runAttempt = async (request: any) => {
      requests.push({ attempt: request.attempt, traceContext: request.traceContext });
      if (request.attempt === 1) throw new Error("retry me");
      return { text: "done", runId: request.runId };
    };
    await tracing.withObservation("shop-turn", "agent", {}, () => manager.run({ profile, task: "work", sessionId: "session-a" }), "session-a");

    const agents = tracing.records.filter((record) => record.type === "agent" && record.name === "delegate");
    assert.equal(agents.length, 1);
    assert.deepEqual(requests.map((request) => request.attempt), [1, 2]);
    assert.ok(requests.every((request) => request.traceContext?.traceId === agents[0].traceId));
    assert.ok(requests.every((request) => request.traceContext?.parentSpanId === agents[0].spanId));
    assert.ok(requests.every((request) => request.traceContext?.sessionId === "session-a"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("market cache hit records the real chain path without fake agents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shop-agent-tracing-cache-"));
  try {
    const root = path.resolve(import.meta.dirname, "..");
    const config = await loadConfig(root, undefined, { paths: { runtimeData: directory } });
    const tracing = new RecordingTracing();
    const manager = new SubagentManager(config, new Map(), undefined, tracing);
    const research = config.agents.find((item) => item.id === "research_agent")!;
    const route = { node_id: "3375", node_name: "乒乓底板", node_path: "体育用品 > 乒乓球用品" };
    const artifact = path.join(directory, "market-criteria", route.node_id);
    await mkdir(artifact, { recursive: true });
    await writeFile(path.join(artifact, "market.json"), JSON.stringify({ cached: true }), "utf8");
    await tracing.withObservation("shop-turn", "agent", {}, () => manager.run({ profile: research, task: JSON.stringify(route), sessionId: "session-a" }));

    assert.equal(tracing.records.filter((record) => record.name === "build-market-criteria" && record.type === "chain").length, 1);
    assert.equal(tracing.records.filter((record) => record.name === "check-market-cache").length, 1);
    assert.equal(tracing.records.filter((record) => record.type === "agent" && record.name !== "shop-turn").length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing credentials selects no-op tracing", () => {
  const names = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_TRACING_ENABLED"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    assert.equal(createTracing().enabled, false);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test("each prompt is one trace, turns share sessionId, and flush failure is fail-open", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shop-agent-tracing-turn-"));
  const tracing = new RecordingTracing();
  let app: Awaited<ReturnType<typeof createShopAgent>> | undefined;
  try {
    app = await createShopAgent({
      cwd: path.resolve(import.meta.dirname, ".."),
      skipAuthCheck: true,
      tracing,
      config: { paths: { runtimeData: directory } },
    });
    let turn = 0;
    app.runtime.models.streamSimple = (model) => {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant",
        content: [{ type: "text", text: `answer-${++turn}` }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { ...usage, reasoning: 0 },
        stopReason: "stop",
        timestamp: Date.now(),
      } as never;
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message } as never);
        stream.push({ type: "text_delta", contentIndex: 0, delta: `answer-${turn}`, partial: message } as never);
        stream.push({ type: "done", reason: "stop", message } as never);
      });
      return stream;
    };
    tracing.throwOnFlush = true;
    await app.prompt("first");
    await app.prompt("second");

    const turns = tracing.records.filter((record) => record.name === "shop-turn" && !record.parentSpanId);
    assert.equal(turns.length, 2);
    assert.notEqual(turns[0].traceId, turns[1].traceId);
    assert.deepEqual(turns.map((record) => record.sessionId), [app.currentSession.id, app.currentSession.id]);
    assert.equal(tracing.records.filter((record) => record.type === "generation").length, 2);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
