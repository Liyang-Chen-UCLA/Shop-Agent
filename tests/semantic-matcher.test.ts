import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelSemanticMatcher } from "../eval/src/semantic-matcher.ts";
import type { ModelRuntime } from "../src/framework/model-runtime.ts";
import { createSemanticMatchBatchTool, createSemanticMatchTool, SharedSemanticMatcher, type SemanticItem } from "../src/framework/semantic-matcher.ts";
import { TaxonomySemanticMatchCache } from "../src/framework/semantic-match-cache.ts";
import { createContractStateTools } from "../src/framework/contract-state.ts";

function item(id: string, name: string, aliases: string[] = []): SemanticItem {
  return { id, name, aliases, type: "categorical" };
}

function fakeRuntime(response: string | Error): { runtime: ModelRuntime; calls: () => number } {
  let requestCount = 0;
  const runtime = {
    getModel(id: string) { return { id }; },
    ensureThinking() {},
    streamSimple() {
      requestCount += 1;
      return {
        result: async () => {
          if (response instanceof Error) throw response;
          return { stopReason: "stop", content: [{ type: "text", text: response }] };
        },
      };
    },
  } as unknown as ModelRuntime;
  return { runtime, calls: () => requestCount };
}

async function writeCache(root: string, nodeId: string, value: unknown): Promise<string> {
  const directory = path.join(root, "market-criteria", nodeId);
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, "semantic-match.json");
  await writeFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
  return filePath;
}

test("exact alias matching completes without an LLM request", async () => {
  const { runtime, calls } = fakeRuntime(new Error("exact match must not call the model"));
  const matcher = new SharedSemanticMatcher({ runtime, modelId: "matcher", sessionId: "test" });

  const result = await matcher.matchOne(
    item("connection_type", "接入方式", ["连接模式"]),
    [item("connection_mode", "连接类型", ["连接模式"])],
  );

  assert.equal(result?.method, "alias");
  assert.equal(result?.right.id, "connection_mode");
  assert.equal(calls(), 0);
});

test("many-to-one deterministic matching reuses one canonical item without an LLM request", async () => {
  const { runtime, calls } = fakeRuntime(new Error("deterministic match must not call the model"));
  const matcher = new SharedSemanticMatcher({ runtime, modelId: "matcher", sessionId: "test" });

  const result = await matcher.matchPairs(
    [item("candidate-a", "同一维度"), item("candidate-b", "同一维度")],
    [item("canonical", "同一维度")],
    { manyToOne: true },
  );

  assert.deepEqual(result.map((pair) => [pair.left.id, pair.right.id, pair.method]), [
    ["candidate-a", "canonical", "name"],
    ["candidate-b", "canonical", "name"],
  ]);
  assert.equal(calls(), 0);
});

test("many-to-one unresolved candidates share one LLM fallback and one canonical item", async () => {
  const { runtime, calls } = fakeRuntime(JSON.stringify({ pairs: [
    { gold_ref: "gold:first", pred_ref: "prediction:canonical" },
    { gold_ref: "gold:second", pred_ref: "prediction:canonical" },
  ] }));
  const matcher = new SharedSemanticMatcher({ runtime, modelId: "matcher", sessionId: "test" });

  const result = await matcher.matchPairs(
    [{ ...item("first", "第一维度"), ref: "gold:first" }, { ...item("second", "第二维度"), ref: "gold:second" }],
    [{ ...item("canonical", "标准维度"), ref: "prediction:canonical" }],
    { manyToOne: true },
  );

  assert.deepEqual(result.map((pair) => [pair.left.id, pair.right.id, pair.method]), [
    ["first", "canonical", "llm"],
    ["second", "canonical", "llm"],
  ]);
  assert.equal(calls(), 1);
});

test("many-to-one positive cache hits reuse one canonical item without an LLM request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shop-agent-semantic-cache-"));
  try {
    await writeCache(root, "301", {
      entries: [{ terms: ["第一维度", "第二维度"], canonical_item_id: "canonical" }],
    });
    const cache = new TaxonomySemanticMatchCache({ runtimeData: root, nodeId: "301", mode: "readOnly" });
    const { runtime, calls } = fakeRuntime(new Error("cache hits must not call the model"));
    const matcher = new SharedSemanticMatcher({ runtime, modelId: "matcher", sessionId: "test", cache });

    const result = await matcher.matchPairs(
      [item("first", "第一维度"), item("second", "第二维度")],
      [item("canonical", "标准维度")],
      { manyToOne: true },
    );

    assert.deepEqual(result.map((pair) => [pair.left.id, pair.right.id, pair.method]), [
      ["first", "canonical", "cache"],
      ["second", "canonical", "cache"],
    ]);
    assert.equal(calls(), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a positive taxonomy cache hit completes without an LLM request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shop-agent-semantic-cache-"));
  try {
    const cache = new TaxonomySemanticMatchCache({ runtimeData: root, nodeId: "301", mode: "readOnly" });
    await writeCache(root, "301", {
      entries: [{ terms: ["连接类型"], canonical_item_id: "connection_mode" }],
    });
    const { runtime, calls } = fakeRuntime(new Error("cache hit must not call the model"));
    const matcher = new SharedSemanticMatcher({ runtime, modelId: "matcher", sessionId: "test", cache });

    const result = await matcher.matchOne(
      item("connection_type", "接入方式", ["连接类型"]),
      [item("connection_mode", "连接模式")],
    );

    assert.equal(result?.method, "cache");
    assert.equal(result?.right.id, "connection_mode");
    assert.equal(calls(), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cache miss falls back to the LLM and stale targets are ignored", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shop-agent-semantic-cache-"));
  try {
    const filePath = await writeCache(root, "301", {
      entries: [{ terms: ["旧连接方式"], canonical_item_id: "removed_item" }],
    });
    const { runtime, calls } = fakeRuntime(JSON.stringify({
      pairs: [{ gold_ref: "gold:candidate", pred_ref: "prediction:canonical" }],
    }));
    const cache = new TaxonomySemanticMatchCache({ runtimeData: root, nodeId: "301", mode: "readOnly" });
    const matcher = new SharedSemanticMatcher({ runtime, modelId: "matcher", sessionId: "test", cache });
    const candidate = { ...item("candidate", "新连接方式"), ref: "gold:candidate" };
    const canonical = { ...item("canonical", "连接模式"), ref: "prediction:canonical" };

    const result = await matcher.matchOne(candidate, [canonical]);

    assert.equal(result?.method, "llm");
    assert.equal(result?.right.id, "canonical");
    assert.equal(calls(), 1);
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
      entries: [{ terms: ["旧连接方式"], canonical_item_id: "removed_item" }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unmatched candidates do not create a cache entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shop-agent-semantic-cache-"));
  try {
    const cache = new TaxonomySemanticMatchCache({ runtimeData: root, nodeId: "301", mode: "readWrite" });
    const { runtime } = fakeRuntime(JSON.stringify({ pairs: [] }));
    const matcher = new SharedSemanticMatcher({ runtime, modelId: "matcher", sessionId: "test", cache });

    const result = await matcher.matchOne(item("candidate", "候选维度"), [item("canonical", "标准维度")]);

    assert.equal(result, undefined);
    await assert.rejects(readFile(cache.filePath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted Market mappings are explicitly persisted in the taxonomy cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shop-agent-semantic-cache-"));
  try {
    const cache = new TaxonomySemanticMatchCache({ runtimeData: root, nodeId: "301", mode: "readWrite" });
    const candidate = item("connection_type", "接入方式", ["连接类型"]);
    const canonical = item("connection_mode", "连接模式");

    assert.equal(await cache.writeAccepted(candidate, canonical), true);
    assert.deepEqual(JSON.parse(await readFile(cache.filePath, "utf8")), {
      entries: [{
        terms: ["connection_type", "接入方式", "连接类型"],
        canonical_item_id: "connection_mode",
      }],
    });

    const readOnly = new TaxonomySemanticMatchCache({ runtimeData: root, nodeId: "301", mode: "readOnly" });
    assert.equal(await readOnly.writeAccepted(item("other", "其他"), canonical), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Eval adapter reads semantic cache without writing it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shop-agent-semantic-cache-"));
  try {
    const filePath = await writeCache(root, "301", {
      entries: [{ terms: ["候选维度"], canonical_item_id: "canonical" }],
    });
    const cache = new TaxonomySemanticMatchCache({ runtimeData: root, nodeId: "301", mode: "readOnly" });
    const { runtime, calls } = fakeRuntime(new Error("Eval cache hit must not call the model"));
    const matcher = new ModelSemanticMatcher(runtime, "matcher", "eval-session", "off", { cache });

    const result = await matcher.match({
      gold: [{ ref: "criteria:candidate", kind: "criteria", item: item("candidate", "候选维度") as any }],
      pred: [{ ref: "attribute:canonical", kind: "attribute", item: item("canonical", "标准维度") as any }],
    });

    assert.deepEqual(result, [{ gold_ref: "criteria:candidate", pred_ref: "attribute:canonical" }]);
    assert.equal(calls(), 0);
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
      entries: [{ terms: ["候选维度"], canonical_item_id: "canonical" }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Market semantic_match updates only trusted aliases and observed product metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shop-agent-semantic-tool-"));
  try {
    const itemSchema = {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        type: { const: "categorical" },
      },
      required: ["id", "name", "aliases", "type"],
      additionalProperties: false,
    };
    const stateTools = createContractStateTools({
      itemSchemas: { criterion: itemSchema, attribute: itemSchema },
      runtimeItemSchema: {
        type: "object",
        properties: { observed_product_ids: { type: "array", items: { type: "string" } } },
        required: ["observed_product_ids"],
        additionalProperties: false,
      },
      runtimeMutableFields: ["aliases", "observed_product_ids"],
    }, {
      criteria: [{ id: "connection_mode", name: "连接类型", aliases: [], type: "categorical", observed_product_ids: [] }],
      attributes: [],
    });
    const cache = new TaxonomySemanticMatchCache({ runtimeData: root, nodeId: "301", mode: "readWrite" });
    const { runtime, calls } = fakeRuntime(new Error("exact identity match must not call the model"));
    const tool = createSemanticMatchTool({
      store: stateTools.store,
      runtime,
      modelId: "matcher",
      sessionId: "market-session",
      cache,
      getActiveProductId: () => "product-1",
    });

    const result = await tool.execute("match-1", {
      kind: "criterion",
      item: { id: "candidate", name: "连接模式", aliases: ["连接类型"], type: "categorical" },
    });
    assert.equal(calls(), 0);
    assert.deepEqual(stateTools.store.get().criteria[0], {
      id: "connection_mode",
      name: "连接类型",
      aliases: ["连接类型", "连接模式"],
      type: "categorical",
      observed_product_ids: ["product-1"],
    });
    assert.equal(JSON.parse((result.content[0] as { text: string }).text).canonical_item_id, "connection_mode");
    assert.deepEqual((await cache.read()).entries, [{
      terms: ["candidate", "连接模式", "连接类型"],
      canonical_item_id: "connection_mode",
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Market semantic_match_batch resolves all candidates once and keeps unmatched definitions for patch_state", async () => {
  const itemSchema = {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      aliases: { type: "array", items: { type: "string" } },
      type: { const: "categorical" },
    },
    required: ["id", "name", "aliases", "type"],
    additionalProperties: false,
  };
  const stateTools = createContractStateTools({
    itemSchemas: { criterion: itemSchema, attribute: itemSchema },
    runtimeItemSchema: {
      type: "object",
      properties: { observed_product_ids: { type: "array", items: { type: "string" } } },
      required: ["observed_product_ids"],
      additionalProperties: false,
    },
    runtimeMutableFields: ["aliases", "observed_product_ids"],
  }, {
    criteria: [{ id: "connection_mode", name: "连接类型", aliases: [], type: "categorical", observed_product_ids: [] }],
    attributes: [],
  });
  const { runtime, calls } = fakeRuntime(JSON.stringify({ pairs: [
    { gold_ref: "criterion:candidate", pred_ref: "criterion:connection_mode" },
  ] }));
  const resolved: any[] = [];
  const tool = createSemanticMatchBatchTool({
    store: stateTools.store,
    runtime,
    modelId: "matcher",
    sessionId: "market-session",
    getActiveProductId: () => "product-1",
    onResolved: (result) => { resolved.push(result); },
  });

  const result = await tool.execute("batch-1", {
    criteria: [{ id: "candidate", name: "连接模式", aliases: [], type: "categorical" }],
    attributes: [{ id: "new-attribute", name: "新属性", aliases: [], type: "categorical" }],
  });
  const value = JSON.parse((result.content[0] as { text: string }).text);

  assert.equal(calls(), 1);
  assert.equal(resolved.length, 1);
  assert.deepEqual(value.matched.map((entry: any) => ({ id: entry.candidate.id, canonical: entry.canonical_item_id })), [
    { id: "candidate", canonical: "connection_mode" },
  ]);
  assert.deepEqual(value.unmatched.map((entry: any) => entry.candidate.id), ["new-attribute"]);
  assert.deepEqual(stateTools.store.get().criteria[0], {
    id: "connection_mode",
    name: "连接类型",
    aliases: ["连接类型", "连接模式"],
    type: "categorical",
    observed_product_ids: ["product-1"],
  });
});

test("Market semantic_match_batch supports multiple extracted candidates mapping to one canonical item", async () => {
  const itemSchema = {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      aliases: { type: "array", items: { type: "string" } },
      type: { const: "categorical" },
    },
    required: ["id", "name", "aliases", "type"],
    additionalProperties: false,
  };
  const stateTools = createContractStateTools({
    itemSchemas: { criterion: itemSchema, attribute: itemSchema },
    runtimeItemSchema: {
      type: "object",
      properties: { observed_product_ids: { type: "array", items: { type: "string" } } },
      required: ["observed_product_ids"],
      additionalProperties: false,
    },
    runtimeMutableFields: ["aliases", "observed_product_ids"],
  }, {
    criteria: [{ id: "connection_mode", name: "标准维度", aliases: [], type: "categorical", observed_product_ids: [] }],
    attributes: [],
  });
  const { runtime, calls } = fakeRuntime(JSON.stringify({ pairs: [
    { gold_ref: "criterion:first", pred_ref: "criterion:connection_mode" },
    { gold_ref: "attribute:second", pred_ref: "criterion:connection_mode" },
  ] }));
  const tool = createSemanticMatchBatchTool({
    store: stateTools.store,
    runtime,
    modelId: "matcher",
    sessionId: "market-session",
    getActiveProductId: () => "product-1",
  });

  const result = await tool.execute("batch-1", {
    criteria: [{ id: "first", name: "第一维度", aliases: [], type: "categorical" }],
    attributes: [{ id: "second", name: "第二维度", aliases: [], type: "categorical" }],
  });
  const value = JSON.parse((result.content[0] as { text: string }).text);

  assert.equal(calls(), 1);
  assert.deepEqual(value.matched.map((entry: any) => [entry.candidate.id, entry.canonical_item_id]), [
    ["first", "connection_mode"],
    ["second", "connection_mode"],
  ]);
  assert.deepEqual(value.unmatched, []);
  assert.deepEqual(stateTools.store.get().criteria[0], {
    id: "connection_mode",
    name: "标准维度",
    aliases: ["标准维度", "第一维度", "第二维度"],
    type: "categorical",
    observed_product_ids: ["product-1"],
  });
});
