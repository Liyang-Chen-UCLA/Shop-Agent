import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/framework/config.ts";
import { createModelRuntime, resolveThinking } from "../src/framework/model-runtime.ts";
import { createPythonAgentTools, discoverPythonTools } from "../src/framework/python-tools.ts";
import { createNativeAgentToolSet, criteriaSearchSatisfied, DEVELOPER_ISSUE_TOOL, MAX_CRITERIA_SEARCH_QUERIES, SEARCH_RESULT_MAX_CHARS, SEARCH_TRUNCATION_MARKER, truncateSearchResult } from "../src/framework/native-tools.ts";
import { validateWithTrustedValidator } from "../src/framework/output-validator.ts";
import { createTerminalOutputTool, SUBMIT_RESULT_TOOL } from "../src/framework/terminal-output.ts";
import { createContractStateTools, PATCH_STATE_BATCH_TOOL, PATCH_STATE_TOOL } from "../src/framework/contract-state.ts";
import { isDeveloperDiagnosticAgentEvent, sanitizeDeveloperDiagnosticAgentEvent, sanitizeDeveloperDiagnosticMessages } from "../src/framework/content.ts";
import { validateJsonSchema } from "../src/framework/schema.ts";
import { SessionStore } from "../src/framework/session-store.ts";
import { createShopAgent } from "../src/framework/shop-agent.ts";
import { PythonWorker } from "../src/framework/python-worker.ts";
import { renderRunCard, renderTaskState, summarizeValue } from "../src/tui/presentation.ts";
import { criteriaOutputSchema } from "../shop/schemas.ts";

const cwd = path.resolve(import.meta.dirname, "..");
const workerDefinitions = await discoverPythonTools(cwd, ["shop/tools", "tests/fixtures"]);
const testPython = new PythonWorker(cwd, { timeoutMs: 30_000, envAllowlist: [] }, workerDefinitions);
await testPython.start();
test.after(async () => testPython.close());

function criteriaValidatorProfile(config: Awaited<ReturnType<typeof loadConfig>>) {
  return {
    ...config.agents.find((agent) => agent.id === "research_agent")!,
    outputSchema: criteriaOutputSchema,
    outputValidator: { id: "criteria_v1" },
  };
}

test("loads project config and OpenCode Go model catalog", async () => {
  const config = await loadConfig(cwd);
  assert.equal(config.orchestrator, "orchestrator");
  assert.equal(config.agents.find((agent) => agent.id === "delegate")?.role, "subagent");
  assert.deepEqual(config.agents.find((agent) => agent.id === "route_agent")?.tools, [
    "taxonomy_search_nodes",
    "taxonomy_get_nodes",
    "taxonomy_get_children",
    "report_developer_issue",
  ]);
  const research = config.agents.find((agent) => agent.id === "research_agent");
  assert.equal(research?.outputValidator, undefined);
  assert.equal(research?.outputSchema, undefined);
  assert.deepEqual(research?.tools, ["web_search", "get_state", "patch_state", "patch_state_batch", "finalize_state", "report_developer_issue"]);
  assert.ok(research?.contractState);
  assert.match(config.agents[0].systemPrompt, /orchestrator/i);

  const runtime = createModelRuntime();
  const model = runtime.getModel("hy3");
  assert.equal(model.provider, "opencode-go");
  runtime.ensureThinking(model, "high");
});

test("resolves thinking for a target model without lowering while a higher level is available", () => {
  const model = {
    id: "test-model",
    reasoning: true,
    thinkingLevelMap: {
      off: "off",
      minimal: "minimal",
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    },
  } as never;

  assert.equal(resolveThinking(model, "low"), "low");
  assert.equal(resolveThinking(model, "medium"), "high");
  assert.equal(resolveThinking(model, "xhigh"), "high");
});

test("resolves to the highest supported thinking level when no higher level exists", () => {
  const model = {
    id: "test-model",
    reasoning: true,
    thinkingLevelMap: {
      off: "off",
      minimal: null,
      low: null,
      medium: null,
      high: "high",
      xhigh: null,
      max: null,
    },
  } as never;

  assert.equal(resolveThinking(model, "minimal"), "high");
});

test("injects OpenCode Go session headers after existing header transforms", async () => {
  const runtime = createModelRuntime();
  const model = runtime.getModel("hy3");
  let capturedOptions: Parameters<typeof runtime.models.streamSimple>[2] | undefined;
  runtime.models.streamSimple = (_model, _context, options) => {
    capturedOptions = options;
    return {} as never;
  };

  runtime.streamSimple(model, { messages: [] }, {
    sessionId: "session-main",
    transformHeaders: (headers) => ({
      ...headers,
      "x-opencode-session": "transformed-session",
      "X-OpenCode-Client": "transformed-client",
      "x-test": "kept",
    }),
  });

  assert.ok(capturedOptions?.transformHeaders);
  assert.deepEqual(await capturedOptions.transformHeaders({ authorization: "token" }), {
    authorization: "token",
    "x-test": "kept",
    "x-opencode-session": "session-main",
    "x-opencode-client": "pi",
  });

  capturedOptions = undefined;
  runtime.streamSimple(model, { messages: [] });
  assert.ok(capturedOptions?.transformHeaders);
  const headersWithoutSession = await capturedOptions.transformHeaders({ "x-test": "kept" });
  assert.equal(headersWithoutSession["x-opencode-session"], undefined);
  assert.equal(headersWithoutSession["x-opencode-client"], undefined);
});

test("uses the configured persistent Python worker timeout and env allowlist", async () => {
  const config = await loadConfig(cwd);
  assert.deepEqual(config.python, { timeoutMs: 60_000, envAllowlist: [] });
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

test("reports actionable branch paths when an anyOf value matches no candidate", () => {
  const schema = {
    anyOf: [
      {
        type: "object",
        properties: { kind: { const: "numeric" }, amount: { type: "number" } },
        required: ["kind", "amount"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { kind: { const: "categorical" }, values: { type: "array" } },
        required: ["kind", "values"],
        additionalProperties: false,
      },
    ],
  };

  const missing = validateJsonSchema(schema, { kind: "numeric" });
  assert.equal(missing.valid, false);
  assert.match((missing as { error: string }).error, /does not match any allowed schema/);
  assert.match((missing as { error: string }).error, /option 1: \$\.amount is required/);
  assert.match((missing as { error: string }).error, /option 2: \$\.values is required/);

  const extra = validateJsonSchema(schema, { kind: "numeric", amount: 1, values: [], extra: true });
  assert.equal(extra.valid, false);
  assert.match((extra as { error: string }).error, /option 1: \$\.values is not allowed/);
  assert.match((extra as { error: string }).error, /option 2: \$\.kind must equal its configured constant/);
  assert.ok((extra as { error: string }).error.length <= 1_000);
});

test("truncates native search output at a safe boundary", () => {
  const result = truncateSearchResult("a".repeat(SEARCH_RESULT_MAX_CHARS + 50));
  assert.equal(result.length, SEARCH_RESULT_MAX_CHARS);
  assert.ok(result.endsWith(SEARCH_TRUNCATION_MARKER));
  assert.equal(truncateSearchResult("short"), "short");
});

test("enforces the four-base-query criteria search policy with one optional follow-up", () => {
  assert.equal(criteriaSearchSatisfied({ attempted: 3, succeeded: 3 }), false);
  assert.equal(criteriaSearchSatisfied({ attempted: 4, succeeded: 0 }), false);
  assert.equal(criteriaSearchSatisfied({ attempted: 4, succeeded: 1 }), true);
  assert.equal(criteriaSearchSatisfied({ attempted: MAX_CRITERIA_SEARCH_QUERIES, succeeded: 1 }), true);
  assert.equal(MAX_CRITERIA_SEARCH_QUERIES, 5);
});

test("structured profiles receive only the unified submit_result terminal tool", async () => {
  const config = await loadConfig(cwd);
  const structured = config.agents.find((agent) => agent.id === "route_agent");
  const ordinary = config.agents.find((agent) => agent.id === "delegate");
  assert.ok(structured?.outputSchema);
  const terminal = createTerminalOutputTool(structured!);
  assert.equal(terminal?.name, SUBMIT_RESULT_TOOL);
  assert.equal(terminal?.parameters, structured?.outputSchema);
  assert.equal(createTerminalOutputTool(ordinary!), undefined);
});

test("framework contract state upserts, overwrites, moves, removes, and finalizes atomically", async () => {
  const itemSchemas = {
    criterion: {
      type: "object",
      properties: { id: { type: "string" }, label: { type: "string" } },
      required: ["id", "label"],
      additionalProperties: false,
    },
    attribute: {
      type: "object",
      properties: { id: { type: "string" }, label: { type: "string" } },
      required: ["id", "label"],
      additionalProperties: false,
    },
  };
  const stateTools = createContractStateTools({ itemSchemas });
  const get = stateTools.tools.find((tool) => tool.name === "get_state")!;
  const patch = stateTools.tools.find((tool) => tool.name === PATCH_STATE_TOOL)!;
  const finalize = stateTools.tools.find((tool) => tool.name === "finalize_state")!;
  const read = async () => JSON.parse(((await get.execute("get", {})).content[0] as { text: string }).text);

  assert.deepEqual(await read(), { criteria: [], attributes: [] });
  const createResult = await patch.execute("create", { op: "upsert", kind: "criterion", item: { id: "A", label: "first" } });
  assert.deepEqual(JSON.parse((createResult.content[0] as { text: string }).text), {
    ok: true,
    applied: [{ op: "upsert", kind: "criterion", item_id: "A" }],
    criteria_count: 1,
    attribute_count: 0,
  });
  assert.equal("state" in (createResult.details as Record<string, unknown>), false);
  assert.deepEqual(await read(), { criteria: [{ id: "A", label: "first" }], attributes: [] });

  await patch.execute("overwrite", { op: "upsert", kind: "criterion", item: { id: "A", label: "second" } });
  assert.deepEqual(await read(), { criteria: [{ id: "A", label: "second" }], attributes: [] });

  await patch.execute("move", { op: "upsert", kind: "attribute", item: { id: "A", label: "attribute" } });
  assert.deepEqual(await read(), { criteria: [], attributes: [{ id: "A", label: "attribute" }] });

  await assert.rejects(
    () => patch.execute("invalid", { op: "upsert", kind: "criterion", item: { id: "B" } }),
    /patch_state arguments.*required|label/,
  );
  assert.deepEqual(await read(), { criteria: [], attributes: [{ id: "A", label: "attribute" }] });

  await patch.execute("remove", { op: "remove", item_id: "A" });
  assert.deepEqual(await read(), { criteria: [], attributes: [] });
  const result = await finalize.execute("finalize", {});
  assert.equal(result.terminate, true);
  assert.deepEqual(stateTools.store.finalized(), { criteria: [], attributes: [] });
});

test("patch_state_batch atomically applies compact receipts and preserves runtime hook semantics", async () => {
  const config = {
    itemSchemas: {
      criterion: {
        type: "object",
        properties: { id: { type: "string" }, label: { type: "string" } },
        required: ["id", "label"],
        additionalProperties: false,
      },
      attribute: {
        type: "object",
        properties: { id: { type: "string" }, label: { type: "string" } },
        required: ["id", "label"],
        additionalProperties: false,
      },
    },
    runtimeItemSchema: {
      type: "object",
      properties: { observed_product_ids: { type: "array", items: { type: "string" } } },
      required: ["observed_product_ids"],
      additionalProperties: false,
    },
    runtimeItemDefaults: { observed_product_ids: [] },
  };
  const hookCalls: string[] = [];
  const stateTools = createContractStateTools(config, undefined, {
    runtime: {
      onUpsert: (_kind, item) => {
        hookCalls.push(String(item.id));
        return { observed_product_ids: ["product-1"] };
      },
    },
  });
  const batch = stateTools.tools.find((tool) => tool.name === PATCH_STATE_BATCH_TOOL)!;
  const raw = {
    patches: [
      { op: "upsert", kind: "criterion", item: JSON.stringify({ id: "criterion-a", label: "A" }) },
      { op: "upsert", kind: "attribute", item: { id: "attribute-a", label: "A" } },
      { op: "remove", item_id: "missing" },
    ],
  };
  const prepared = batch.prepareArguments!(raw);
  assert.notEqual(prepared, raw);
  const result = await batch.execute("batch", prepared);
  const receipt = JSON.parse((result.content[0] as { text: string }).text);
  assert.deepEqual(receipt, {
    ok: true,
    applied: [
      { op: "upsert", kind: "criterion", item_id: "criterion-a" },
      { op: "upsert", kind: "attribute", item_id: "attribute-a" },
      { op: "remove", item_id: "missing" },
    ],
    criteria_count: 1,
    attribute_count: 1,
  });
  assert.deepEqual(result.details, { tool: PATCH_STATE_BATCH_TOOL, ...receipt });
  assert.doesNotMatch(JSON.stringify(result), /"criteria"\s*:/);
  assert.doesNotMatch(JSON.stringify(result), /"attributes"\s*:/);
  assert.deepEqual(hookCalls, ["criterion-a", "attribute-a"]);
  assert.deepEqual(stateTools.store.get(), {
    criteria: [{ id: "criterion-a", label: "A", observed_product_ids: ["product-1"] }],
    attributes: [{ id: "attribute-a", label: "A", observed_product_ids: ["product-1"] }],
  });
});

test("patch_state_batch leaves state unchanged when a later patch fails", async () => {
  const itemSchemas = {
    criterion: {
      type: "object",
      properties: { id: { type: "string" }, label: { type: "string" } },
      required: ["id", "label"],
      additionalProperties: false,
    },
    attribute: {
      type: "object",
      properties: { id: { type: "string" }, label: { type: "string" } },
      required: ["id", "label"],
      additionalProperties: false,
    },
  };
  const hookCalls: string[] = [];
  const stateTools = createContractStateTools({ itemSchemas }, undefined, {
    runtime: {
      onUpsert: (_kind, item) => {
        hookCalls.push(String(item.id));
        if (item.id === "second") throw new Error("runtime hook failed");
      },
    },
  });
  const batch = stateTools.tools.find((tool) => tool.name === PATCH_STATE_BATCH_TOOL)!;
  await assert.rejects(
    () => batch.execute("hook-failure", {
      patches: [
        { op: "upsert", kind: "criterion", item: { id: "first", label: "First" } },
        { op: "upsert", kind: "criterion", item: { id: "second", label: "Second" } },
      ],
    }),
    /runtime hook failed/,
  );
  assert.deepEqual(hookCalls, ["first", "second"]);
  assert.deepEqual(stateTools.store.get(), { criteria: [], attributes: [] });

  await assert.rejects(
    () => batch.execute("schema-failure", {
      patches: [
        { op: "upsert", kind: "criterion", item: { id: "valid", label: "Valid" } },
        { op: "upsert", kind: "criterion", item: { id: "invalid" } },
      ],
    }),
    /patch_state_batch arguments.*required|label/,
  );
  assert.deepEqual(stateTools.store.get(), { criteria: [], attributes: [] });
});

test("Research uses the shared patch_state_batch infrastructure for initial contract items", async () => {
  const config = await loadConfig(cwd);
  const profile = config.agents.find((agent) => agent.id === "research_agent")!;
  assert.ok(profile.contractState);
  assert.ok(profile.tools?.includes(PATCH_STATE_BATCH_TOOL));

  const batched = createContractStateTools(profile.contractState!);
  const individual = createContractStateTools(profile.contractState!);
  const patches = {
    patches: [
      {
        op: "upsert",
        kind: "criterion",
        item: {
          id: "battery_life",
          name: "续航时间",
          description: "产品可持续使用的时间",
          aliases: ["续航"],
          type: "numeric",
          units: ["小时"],
          direction: { type: "larger_better" },
        },
      },
      {
        op: "upsert",
        kind: "criterion",
        item: {
          id: "waterproof",
          name: "防水能力",
          description: "产品抵抗进水的能力",
          aliases: [],
          type: "boolean",
          direction: { type: "true_better" },
        },
      },
      {
        op: "upsert",
        kind: "attribute",
        item: {
          id: "color",
          name: "颜色",
          description: "产品外观颜色",
          aliases: [],
          type: "categorical",
          values: ["黑色", "白色"],
          value_domain: "open",
        },
      },
      {
        op: "upsert",
        kind: "attribute",
        item: {
          id: "weight",
          name: "重量",
          description: "产品自身重量",
          aliases: [],
          type: "numeric",
          units: ["克"],
        },
      },
    ],
  };
  const batch = batched.tools.find((tool) => tool.name === PATCH_STATE_BATCH_TOOL)!;
  const result = await batch.execute("research-batch", patches);
  const receipt = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.criteria_count, 2);
  assert.equal(receipt.attribute_count, 2);
  assert.doesNotMatch(JSON.stringify(result), /"criteria"\s*:/);
  assert.doesNotMatch(JSON.stringify(result), /"attributes"\s*:/);
  assert.equal("state" in (result.details as Record<string, unknown>), false);

  const get = batched.tools.find((tool) => tool.name === "get_state")!;
  const stateFromGet = JSON.parse(((await get.execute("research-get", {})).content[0] as { text: string }).text);
  assert.deepEqual(stateFromGet, batched.store.get());

  const patch = individual.tools.find((tool) => tool.name === PATCH_STATE_TOOL)!;
  for (const patchInput of patches.patches) await patch.execute("research-single", patchInput);
  assert.deepEqual(batched.store.get(), individual.store.get());
});

test("patch_state prepares a stringified object item without weakening validation", async () => {
  const itemSchemas = {
    criterion: {
      type: "object",
      properties: { id: { type: "string" }, label: { type: "string" } },
      required: ["id", "label"],
      additionalProperties: false,
    },
    attribute: {
      type: "object",
      properties: { id: { type: "string" }, label: { type: "string" } },
      required: ["id", "label"],
      additionalProperties: false,
    },
  };
  const stateTools = createContractStateTools({ itemSchemas });
  const patch = stateTools.tools.find((tool) => tool.name === "patch_state")!;
  const raw = { op: "upsert", kind: "criterion", item: JSON.stringify({ id: "A", label: "Alpha" }) };
  assert.throws(() => stateTools.store.patch(raw), /patch_state arguments.*object|schema/);
  const prepared = patch.prepareArguments!(raw);

  await patch.execute("stringified", prepared);
  assert.deepEqual(stateTools.store.get().criteria, [{ id: "A", label: "Alpha" }]);

  const invalid = { op: "upsert", kind: "criterion", item: "{not-json" };
  assert.deepEqual(patch.prepareArguments!(invalid), invalid);
  await assert.rejects(
    () => patch.execute("invalid-string", patch.prepareArguments!(invalid)),
    /patch_state arguments.*object|schema/,
  );
  const arrayItem = { op: "upsert", kind: "criterion", item: "[]" };
  assert.deepEqual(patch.prepareArguments!(arrayItem), arrayItem);
  await assert.rejects(
    () => patch.execute("array-string", patch.prepareArguments!(arrayItem)),
    /patch_state arguments.*object|schema/,
  );
});

test("Market runtime metadata is initialized, preserved across upserts and kind moves, and cannot be patched by the model", async () => {
  const config = {
    itemSchemas: {
      criterion: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" }, aliases: { type: "array", items: { type: "string" } } },
        required: ["id", "name", "aliases"],
        additionalProperties: false,
      },
      attribute: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" }, aliases: { type: "array", items: { type: "string" } } },
        required: ["id", "name", "aliases"],
        additionalProperties: false,
      },
    },
    runtimeItemSchema: {
      type: "object",
      properties: { observed_product_ids: { type: "array", items: { type: "string" } } },
      required: ["observed_product_ids"],
      additionalProperties: false,
    },
    runtimeItemDefaults: { observed_product_ids: [] },
    runtimeMutableFields: ["aliases", "observed_product_ids"],
  };
  let activeProduct = "p1";
  const stateTools = createContractStateTools(config, undefined, {
    runtime: {
      onUpsert: (_kind, _item, existing) => ({
        observed_product_ids: [...new Set([...(Array.isArray(existing?.observed_product_ids) ? existing.observed_product_ids as string[] : []), activeProduct])],
      }),
    },
  });
  const patch = stateTools.tools.find((tool) => tool.name === "patch_state")!;
  const read = () => stateTools.store.get();

  await patch.execute("create", { op: "upsert", kind: "criterion", item: { id: "A", name: "Alpha", aliases: [] } });
  assert.deepEqual(read().criteria[0]?.observed_product_ids, ["p1"]);
  activeProduct = "p2";
  await patch.execute("overwrite", { op: "upsert", kind: "criterion", item: { id: "A", name: "Alpha updated", aliases: ["a"] } });
  assert.deepEqual(read().criteria[0], { id: "A", name: "Alpha updated", aliases: ["a"], observed_product_ids: ["p1", "p2"] });
  await patch.execute("move", { op: "upsert", kind: "attribute", item: { id: "A", name: "Alpha attribute", aliases: [] } });
  assert.deepEqual(read(), { criteria: [], attributes: [{ id: "A", name: "Alpha attribute", aliases: [], observed_product_ids: ["p1", "p2"] }] });

  await assert.rejects(
    () => patch.execute("forged-runtime", { op: "upsert", kind: "attribute", item: { id: "B", name: "Beta", aliases: [], observed_product_ids: ["p3"] } }),
    /patch_state arguments.*observed_product_ids|not allowed/,
  );
  assert.equal(read().attributes.length, 1);
});

test("finalize_state awaits publication and only finalizes after the hook succeeds", async () => {
  const config = {
    itemSchemas: {
      criterion: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      attribute: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    },
  };
  let published: unknown;
  let rejectPublication = true;
  const stateTools = createContractStateTools(config, undefined, {
    onFinalize: async (state) => {
      await Promise.resolve();
      if (rejectPublication) throw new Error("publication failed");
      published = state;
    },
  });
  const finalize = stateTools.tools.find((tool) => tool.name === "finalize_state")!;

  await assert.rejects(() => finalize.execute("failed-finalize", {}), /publication failed/);
  assert.equal(stateTools.store.isFinalized, false);
  assert.equal(published, undefined);

  rejectPublication = false;
  const result = await finalize.execute("successful-finalize", {});
  assert.equal(result.terminate, true);
  assert.deepEqual(published, { criteria: [], attributes: [] });
  assert.deepEqual((result.details as any).state, { criteria: [], attributes: [] });
  assert.deepEqual(stateTools.store.finalized(), { criteria: [], attributes: [] });
});

test("submit_result accepts schema-valid arguments and stores the result", async () => {
  const config = await loadConfig(cwd);
  const profile = config.agents.find((agent) => agent.id === "route_agent")!;
  const terminal = createTerminalOutputTool(profile)!;
  const value = { results: [] };
  const result = await terminal.execute("submit-route", value);
  assert.equal(result.terminate, true);
  assert.equal(terminal.state.submitted, true);
  assert.deepEqual(terminal.state.validatedValue, value);
});

test("submit_result returns a tool error for schema-invalid arguments", async () => {
  const config = await loadConfig(cwd);
  const profile = config.agents.find((agent) => agent.id === "route_agent")!;
  const terminal = createTerminalOutputTool(profile)!;
  await assert.rejects(
    () => terminal.execute("submit-invalid", { wrong: true }),
    /output schema/,
  );
  assert.equal(terminal.state.submitted, false);
});

test("submit_result propagates criteria_v1 rejection as a tool error", async () => {
  const config = await loadConfig(cwd);
  const profile = criteriaValidatorProfile(config);
  const terminal = createTerminalOutputTool(profile, { python: testPython })!;
  const invalid = {
    node: { id: "267", name: "手机", path: ["电子产品", "通讯"] },
    criteria: [{
      id: "battery_life",
      name: "续航",
      description: "d",
      aliases: [],
      type: "numeric",
      units: [],
      direction: { type: "target_range", unit: "小时" },
    }],
    attributes: [],
  };
  await assert.rejects(
    () => terminal.execute("submit-criteria-invalid", invalid),
    /criteria_v1.*rejected|target_range\.unit/,
  );
  assert.equal(terminal.state.submitted, false);
});

test("stateful Market profiles use finalize_state instead of submit_result", async () => {
  const config = await loadConfig(cwd);
  const profile = config.agents.find((agent) => agent.id === "market_agent")!;
  assert.equal(createTerminalOutputTool(profile, { python: testPython }), undefined);
  assert.ok(profile.contractState);
  assert.deepEqual(profile.tools?.filter((tool) => ["get_state", "patch_state", "patch_state_batch", "finalize_state"].includes(tool)), ["get_state", "patch_state", "patch_state_batch", "finalize_state"]);
});

test("submit_result stores the trusted validator value", async () => {
  const config = await loadConfig(cwd);
  const profile = criteriaValidatorProfile(config);
  const terminal = createTerminalOutputTool(profile, { python: testPython })!;
  const value = {
    node: { id: "267", name: "手机", path: ["电子产品", "通讯"] },
    criteria: [],
    attributes: [],
  };
  await terminal.execute("submit-criteria-valid", value);
  assert.equal(terminal.state.submitted, true);
  assert.deepEqual(terminal.state.validatedValue, value);
});

test("diagnostic events and persisted messages are redacted without breaking tool pairing", () => {
  const assistant = {
    role: "assistant",
    content: [{ type: "toolCall", id: "diag-call", name: "report_developer_issue", arguments: { evidence: "secret" } }],
  } as never;
  const result = {
    role: "toolResult",
    toolCallId: "diag-call",
    toolName: "report_developer_issue",
    content: [{ type: "text", text: "developer issue recorded" }],
    details: { evidence: "secret" },
    isError: false,
    timestamp: Date.now(),
  } as never;
  const sanitized = sanitizeDeveloperDiagnosticMessages([assistant, result]);
  assert.equal((sanitized[0] as any).content[0].id, "diag-call");
  assert.equal((sanitized[0] as any).content[0].arguments.redacted, "[DEVELOPER_DIAGNOSTIC_REDACTED]");
  assert.equal((sanitized[1] as any).details, "[DEVELOPER_DIAGNOSTIC_REDACTED]");
  assert.doesNotMatch(JSON.stringify(sanitized), /secret/);
  assert.equal(isDeveloperDiagnosticAgentEvent({ type: "tool_execution_start", toolName: "report_developer_issue" }), true);
  assert.equal(isDeveloperDiagnosticAgentEvent({ type: "tool_execution_end", toolName: "web_search" }), false);
  const ended = sanitizeDeveloperDiagnosticAgentEvent({ type: "agent_end", messages: [assistant, result] }) as any;
  assert.doesNotMatch(JSON.stringify(ended), /secret/);
});

test("native developer diagnostics use trusted context and bounded JSONL", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "shop-agent-feedback-test-"));
  try {
    const set = createNativeAgentToolSet([DEVELOPER_ISSUE_TOOL], {
      runtime: {} as never,
      projectRoot: directory,
      getRuntimeContext: () => ({ sessionId: "trusted-session", agentName: "route_agent", projectRoot: directory }),
    });
    await set.tools[0].execute("feedback-call", {
      category: "other",
      summary: "s".repeat(2_000),
      context: "context",
      affected_entities: ["node"],
      evidence: ["evidence"],
      action_taken: "omitted",
    });
    const { readFile } = await import("node:fs/promises");
    const line = (await readFile(path.join(directory, ".shop-agent", "developer-feedback", "issues.jsonl"), "utf8")).trim();
    const record = JSON.parse(line) as { session_id: string; agent: string; summary: string; projectRoot?: string };
    assert.equal(record.session_id, "trusted-session");
    assert.equal(record.agent, "route_agent");
    assert.equal(record.summary.length, 500);
    assert.equal(record.projectRoot, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trusted criteria validator accepts a minimal document and rejects semantic errors", async () => {
  const valid = await validateWithTrustedValidator({ id: "criteria_v1" }, {
    node: { id: "267", name: "手机", path: ["电子产品", "通讯"] },
    criteria: [],
    attributes: [],
  }, testPython);
  assert.equal(valid.valid, true);
  const invalid = await validateWithTrustedValidator({ id: "criteria_v1" }, {
    node: { id: "267", name: "手机", path: ["电子产品", "通讯"] },
    criteria: [{ id: "battery_life", name: "续航", description: "d", aliases: [], type: "numeric", units: [], direction: { type: "target_range", unit: "小时" } }],
    attributes: [],
  }, testPython);
  assert.equal(invalid.valid, false);
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
  const definitions = workerDefinitions;
  const tools = createPythonAgentTools(definitions, ["echo_python"], testPython);
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
    const session = await store.create("hy3", "high");
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
  const definitions = workerDefinitions;
  const tools = createPythonAgentTools(
    definitions,
    ["taxonomy_search_nodes", "taxonomy_get_nodes", "taxonomy_get_children"],
    testPython,
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
    const definitions = workerDefinitions;
    const context = (sessionId: string) => ({ sessionId, dataDirectory: directory });
    const sessionATools = createPythonAgentTools(
      definitions,
      ["task_state_get", "task_state_upsert"],
      testPython,
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
      testPython,
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
  let app: Awaited<ReturnType<typeof createShopAgent>> | undefined;
  try {
    app = await createShopAgent({
      cwd,
      skipAuthCheck: true,
      config: { paths: { runtimeData: directory } },
    });
    assert.deepEqual(app.agent.state.tools.map((tool) => tool.name), [
      "task_state_get",
      "task_state_upsert",
      "task_state_set_active",
      "task_state_delete",
      "delegate_agent",
      "report_developer_issue",
    ]);
    const result = await app.agent.state.tools[4].execute("list-call", { action: "list" });
    const agents = JSON.parse((result.content[0] as { text: string }).text) as { id: string }[];
    assert.deepEqual(agents.map((agent) => agent.id), ["route_agent", "research_agent", "delegate"]);

    const state = await app.getTaskState();
    assert.deepEqual(state.tasks, []);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
