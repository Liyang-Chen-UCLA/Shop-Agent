import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelDefinitionJudge } from "../eval/src/definition-judge.ts";
import { ModelSemanticMatcher } from "../eval/src/semantic-matcher.ts";
import { loadEvalCase, loadPredictionArtifacts } from "../eval/src/loaders.ts";
import { fieldDiffs } from "../eval/src/metrics.ts";
import { runEvaluation } from "../eval/src/pipeline.ts";
import { LangfuseEvalTelemetry } from "../eval/src/telemetry.ts";
import type { ModelRuntime } from "../src/framework/model-runtime.ts";
import type {
  CriteriaDocument,
  DefinitionResult,
  DefinitionJudge,
  DefinitionJudgeInput,
  EvalResult,
  EvalTelemetry,
  EvaluationInput,
  FieldDiff,
  FailureUnit,
  SemanticMatchInput,
  SemanticMatcher,
  SessionScorePayload,
  SessionScoreWriter,
} from "../eval/src/types.ts";

const NODE = { id: "42", name: "通用品类", path: ["根", "通用品类"] };

function numeric(id: string, name = id, units = ["ms"]) {
  return {
    id,
    name,
    description: `${name} definition`,
    aliases: [] as string[],
    type: "numeric",
    units,
    formula: null,
    direction: { type: "smaller_better" },
  };
}

function categorical(id: string, name = id) {
  return {
    id,
    name,
    description: `${name} definition`,
    aliases: [] as string[],
    type: "categorical",
    values: ["a", "b"],
    value_domain: "open",
  };
}

function document(
  criteria: CriteriaDocument["criteria"] = [],
  attributes: CriteriaDocument["attributes"] = [],
  node = NODE,
): CriteriaDocument {
  return { node, criteria, attributes };
}

function marketPrediction(value: CriteriaDocument): CriteriaDocument {
  const observed = (item: CriteriaDocument["criteria"][number]) => (
    Object.hasOwn(item, "observed_product_ids")
      ? item
      : { ...item, observed_product_ids: ["test-product"] }
  );
  return {
    ...value,
    criteria: value.criteria.map(observed),
    attributes: value.attributes.map(observed),
  };
}

class MockTelemetry implements EvalTelemetry {
  semanticInputs: SemanticMatchInput[] = [];
  failures: FailureUnit[] = [];
  scoreResults: EvalResult[] = [];
  benchmarkInputs: EvaluationInput[] = [];

  async withBenchmark(input: EvaluationInput, run: () => Promise<EvalResult>): Promise<EvalResult> {
    this.benchmarkInputs.push(input);
    return run();
  }
  async observeSemanticMatch<T>(input: SemanticMatchInput, run: () => Promise<T>): Promise<T> {
    this.semanticInputs.push(input);
    return run();
  }
  async observeDefinitionJudge(_input: DefinitionJudgeInput, _ruleDiffs: readonly FieldDiff[], run: () => Promise<DefinitionResult>): Promise<DefinitionResult> {
    return run();
  }
  async recordFailure(failure: FailureUnit): Promise<void> { this.failures.push(failure); }
  async writeSessionScores(result: EvalResult): Promise<void> { this.scoreResults.push(result); }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

const noSemanticMatches: SemanticMatcher = { async match() { return []; } };

function definitionInput(gold: ReturnType<typeof numeric>, pred: ReturnType<typeof numeric>): DefinitionJudgeInput {
  return {
    gold: { ref: `criteria:${gold.id}`, kind: "criteria", item: gold },
    pred: { ref: `criteria:${pred.id}`, kind: "criteria", item: pred },
  };
}

function fakeDefinitionRuntime(response: string | Error): { runtime: ModelRuntime; calls: () => number; contexts: unknown[] } {
  const state = { calls: 0, contexts: [] as unknown[] };
  const runtime = {
    getModel() { return { id: "definition-judge" }; },
    ensureThinking() {},
    streamSimple(_model: unknown, context: unknown) {
      state.calls += 1;
      state.contexts.push(context);
      return {
        result: async () => {
          if (response instanceof Error) throw response;
          return { stopReason: "stop", content: [{ type: "text", text: response }] };
        },
      };
    },
  } as unknown as ModelRuntime;
  return { runtime, calls: () => state.calls, contexts: state.contexts };
}

async function evaluate(
  gold: CriteriaDocument,
  prediction: CriteriaDocument,
  base?: CriteriaDocument,
  matcher: SemanticMatcher = noSemanticMatches,
  definitionJudge?: DefinitionJudge,
): Promise<{ result: EvalResult; telemetry: MockTelemetry }> {
  const telemetry = new MockTelemetry();
  const result = await runEvaluation({
    caseId: "generic",
    sessionId: "session-1",
    gold,
    prediction: marketPrediction(prediction),
    base,
  }, matcher, telemetry, definitionJudge);
  return { result, telemetry };
}

test("loads any safe eval/cases/<case-id>/gold.json path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shop-agent-eval-case-"));
  try {
    const directory = path.join(root, "eval", "cases", "camera");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "gold.json"), JSON.stringify(document([{
      ...numeric("latency"),
      evidence_item_ids: ["shopping-env-1"],
    }])), "utf8");
    const loaded = await loadEvalCase(root, "camera");
    assert.equal(loaded.node.id, NODE.id);
    assert.equal(loaded.criteria[0].id, "latency");
    assert.deepEqual(loaded.criteria[0].evidence_item_ids, ["shopping-env-1"]);
    await assert.rejects(() => loadEvalCase(root, "../escape"), /safe case id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filters unobserved Market items while preserving the unfiltered base artifact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shop-agent-eval-artifacts-"));
  try {
    const directory = path.join(root, "market-criteria", NODE.id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "market.json"), JSON.stringify(document(
      [{ ...numeric("A"), observed_product_ids: [] }, { ...numeric("B"), observed_product_ids: ["p1"] }],
      [{ ...categorical("C"), observed_product_ids: [] }, { ...categorical("D"), observed_product_ids: ["p1"] }],
    )), "utf8");
    await writeFile(path.join(directory, "base.json"), JSON.stringify(document(
      [numeric("A"), numeric("B")],
      [categorical("C"), categorical("D")],
    )), "utf8");

    const loaded = await loadPredictionArtifacts(root, NODE.id);

    assert.deepEqual(loaded.prediction.criteria.map((item) => item.id), ["B"]);
    assert.deepEqual(loaded.prediction.attributes.map((item) => item.id), ["D"]);
    assert.deepEqual(loaded.base?.criteria.map((item) => item.id), ["A", "B"]);
    assert.deepEqual(loaded.base?.attributes.map((item) => item.id), ["C", "D"]);
    assert.equal(Object.hasOwn(loaded.base?.criteria[0] ?? {}, "observed_product_ids"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a Market prediction item without a legal observed_product_ids field", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shop-agent-eval-artifacts-"));
  try {
    const directory = path.join(root, "market-criteria", NODE.id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "market.json"), JSON.stringify(document([numeric("missing-observation")])), "utf8");

    await assert.rejects(
      () => loadPredictionArtifacts(root, NODE.id),
      /observed_product_ids is required/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ships gamepad as the first real Gold fixture", async () => {
  const loaded = await loadEvalCase(path.resolve(import.meta.dirname, ".."), "gamepad");
  assert.equal(loaded.node.id, "301");
  assert.equal(loaded.node.name, "游戏手柄");
  assert.ok(loaded.criteria.length > 0);
  assert.ok(loaded.attributes.length > 0);
});

test("perfect match produces all precision, recall and F1 values at 1", async () => {
  const gold = document([numeric("latency")], [categorical("connection")]);
  const { result } = await evaluate(gold, structuredClone(gold));
  assert.deepEqual(result.metrics, {
    route_correctness: 1,
    criteria_precision: 1,
    criteria_recall: 1,
    criteria_f1: 1,
    attribute_precision: 1,
    attribute_recall: 1,
    attribute_f1: 1,
    matched_item_field_accuracy: 1,
  });
  assert.deepEqual(result.failures, []);
});

test("missing prediction item creates a missing FailureUnit", async () => {
  const { result } = await evaluate(document([numeric("latency")]), document());
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].diff_type, "missing");
  assert.equal(result.metrics.criteria_recall, 0);
});

test("extra prediction item creates an extra FailureUnit", async () => {
  const { result } = await evaluate(document(), document([], [{
    ...categorical("color"),
    observed_product_ids: ["p-extra"],
  }]));
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].diff_type, "extra");
  assert.equal(result.failures[0].pred_item?.id, "color");
  assert.equal(result.metrics.attribute_precision, 0);
});

test("unobserved Market items do not enter scoring or missing-extra comparison", async () => {
  const gold = document([numeric("kept")], [categorical("kept-attribute")]);
  const prediction = document(
    [{ ...numeric("ignored"), observed_product_ids: [] }, { ...numeric("kept"), observed_product_ids: ["p1"] }],
    [{ ...categorical("ignored-attribute"), observed_product_ids: [] }, { ...categorical("kept-attribute"), observed_product_ids: ["p1"] }],
  );

  const { result } = await evaluate(gold, prediction);

  assert.deepEqual(result.pairings.map((pair) => pair.pred_ref), ["criteria:kept", "attribute:kept-attribute"]);
  assert.deepEqual(result.failures, []);
  assert.equal(result.metrics.criteria_precision, 1);
  assert.equal(result.metrics.criteria_recall, 1);
  assert.equal(result.metrics.criteria_f1, 1);
  assert.equal(result.metrics.attribute_precision, 1);
  assert.equal(result.metrics.attribute_recall, 1);
  assert.equal(result.metrics.attribute_f1, 1);
});

test("observed_product_ids are excluded from definition comparison", async () => {
  const gold = document([numeric("runtime", "Runtime", ["ms"])]);
  const prediction = document([{
    ...numeric("runtime", "Runtime", ["ms"]),
    observed_product_ids: ["p1", "p2"],
  }]);

  const { result } = await evaluate(gold, prediction);

  assert.deepEqual(result.failures, []);
  assert.equal(result.metrics.matched_item_field_accuracy, 1);
});

test("same dimension in a different collection creates wrong_kind", async () => {
  const shared = numeric("latency", "Latency");
  const { result } = await evaluate(document([shared]), document([], [shared]));
  assert.ok(result.failures.some((failure) => failure.diff_type === "wrong_kind"));
  assert.equal(result.metrics.criteria_recall, 0);
  assert.equal(result.metrics.attribute_precision, 0);
});

test("wrong applicable field creates wrong_definition and lowers field accuracy", async () => {
  const { result } = await evaluate(
    document([numeric("latency", "Latency", ["ms"])]),
    document([numeric("latency", "Latency", ["seconds"])]),
  );
  const failure = result.failures.find((item) => item.diff_type === "wrong_definition");
  assert.deepEqual(failure?.field_diffs?.map((item) => item.field), ["units"]);
  assert.ok(result.metrics.matched_item_field_accuracy < 1);
});

test("semantic matcher is injectable and its one-to-one pairings are used", async () => {
  let calls = 0;
  const matcher: SemanticMatcher = {
    async match(input) {
      calls += 1;
      return [{ gold_ref: input.gold[0].ref, pred_ref: input.pred[0].ref }];
    },
  };
  const { result, telemetry } = await evaluate(
    document([numeric("response_delay", "Response delay")]),
    document([numeric("input_lag", "Input lag")]),
    undefined,
    matcher,
  );
  assert.equal(calls, 1);
  assert.equal(telemetry.semanticInputs.length, 1);
  assert.equal(result.pairings[0].method, "semantic");
  assert.equal(result.metrics.criteria_f1, 1);
});

test("Eval keeps SharedSemanticMatcher's default one-to-one semantic validation", async () => {
  const { runtime } = fakeDefinitionRuntime(JSON.stringify({ pairs: [
    { gold_ref: "criteria:first", pred_ref: "criteria:canonical" },
    { gold_ref: "criteria:second", pred_ref: "criteria:canonical" },
  ] }));
  const matcher = new ModelSemanticMatcher(runtime, "matcher", "eval-session");

  await assert.rejects(
    () => matcher.match({
      gold: [
        { ref: "criteria:first", kind: "criteria", item: numeric("first", "第一维度") },
        { ref: "criteria:second", kind: "criteria", item: numeric("second", "第二维度") },
      ],
      pred: [{ ref: "criteria:canonical", kind: "criteria", item: numeric("canonical", "标准维度") }],
    }),
    /one-to-one pairings/,
  );
});

test("definition judge skips the LLM when rule fieldDiffs are empty", async () => {
  const { runtime, calls } = fakeDefinitionRuntime(new Error("must not call"));
  const judge = new ModelDefinitionJudge(runtime, "judge", "session-1");
  const input = definitionInput(
    numeric("latency", "Latency", ["hour"]),
    numeric("response_time", "Latency", ["hour"]),
  );

  const result = await judge.judge(input);
  assert.equal(calls(), 0);
  assert.deepEqual(result, { rule_diffs: [], final_diffs: [], judgments: [] });
});

test("definition judge can mark 小时 and hour as semantically equivalent", async () => {
  const { runtime, calls } = fakeDefinitionRuntime(JSON.stringify({ judgments: [
    { field: "units", equivalent: true, reason: "小时 and hour are the same unit." },
  ] }));
  const judge = new ModelDefinitionJudge(runtime, "judge", "session-1");

  const result = await judge.judge(definitionInput(
    numeric("latency", "Latency", ["小时"]),
    numeric("response_time", "Latency", ["hour"]),
  ));
  assert.equal(calls(), 1);
  assert.deepEqual(result.rule_diffs.map((item) => item.field), ["units"]);
  assert.deepEqual(result.final_diffs, []);
  assert.deepEqual(result.judgments, [{
    field: "units",
    equivalent: true,
    reason: "小时 and hour are the same unit.",
  }]);
});

test("definition judge keeps 小时 and 分钟 semantically different", async () => {
  const { runtime } = fakeDefinitionRuntime(JSON.stringify({ judgments: [
    { field: "units", equivalent: false, reason: "小时 and 分钟 measure different durations." },
  ] }));
  const judge = new ModelDefinitionJudge(runtime, "judge", "session-1");

  const result = await judge.judge(definitionInput(
    numeric("latency", "Latency", ["小时"]),
    numeric("response_time", "Latency", ["分钟"]),
  ));
  assert.deepEqual(result.final_diffs.map((item) => item.field), ["units"]);
  assert.equal(result.judgments[0]?.equivalent, false);
});

test("definition judge supports partial semantic overrides across multiple fields", async () => {
  const { runtime } = fakeDefinitionRuntime(JSON.stringify({ judgments: [
    { field: "units", equivalent: true, reason: "小时 and hour are equivalent." },
    { field: "direction", equivalent: false, reason: "The optimization directions differ." },
  ] }));
  const judge = new ModelDefinitionJudge(runtime, "judge", "session-1");
  const gold = numeric("latency", "Latency", ["小时"]);
  const pred = { ...numeric("response_time", "Latency", ["hour"]), direction: { type: "larger_better" } };

  const result = await judge.judge(definitionInput(gold, pred));
  assert.deepEqual(result.rule_diffs.map((item) => item.field), ["direction", "units"]);
  assert.deepEqual(result.judgments.map((item) => ({ field: item.field, equivalent: item.equivalent })), [
    { field: "direction", equivalent: false },
    { field: "units", equivalent: true },
  ]);
  assert.deepEqual(result.final_diffs.map((item) => item.field), ["direction"]);
});

test("evaluation uses empty final diffs for an equivalent 小时/hour unit", async () => {
  const { runtime } = fakeDefinitionRuntime(JSON.stringify({ judgments: [
    { field: "units", equivalent: true, reason: "小时 and hour are equivalent." },
  ] }));
  const definitionJudge = new ModelDefinitionJudge(runtime, "judge", "session-1");
  const { result } = await evaluate(
    document([numeric("latency", "Latency", ["小时"])]),
    document([numeric("response_time", "Latency", ["hour"])]),
    undefined,
    noSemanticMatches,
    definitionJudge,
  );

  assert.equal(result.metrics.matched_item_field_accuracy, 1);
  assert.equal(result.failures.some((item) => item.diff_type === "wrong_definition"), false);
});

test("evaluation retains a final diff for non-equivalent 小时/minute units", async () => {
  const { runtime } = fakeDefinitionRuntime(JSON.stringify({ judgments: [
    { field: "units", equivalent: false, reason: "小时 and 分钟 are different units." },
  ] }));
  const definitionJudge = new ModelDefinitionJudge(runtime, "judge", "session-1");
  const { result } = await evaluate(
    document([numeric("latency", "Latency", ["小时"])]),
    document([numeric("response_time", "Latency", ["分钟"])]),
    undefined,
    noSemanticMatches,
    definitionJudge,
  );

  const failure = result.failures.find((item) => item.diff_type === "wrong_definition");
  assert.deepEqual(failure?.field_diffs?.map((item) => item.field), ["units"]);
  assert.equal(result.metrics.matched_item_field_accuracy, 2 / 3);
});

test("wrong_kind remains independent and can coexist with wrong_definition", async () => {
  const { runtime } = fakeDefinitionRuntime(JSON.stringify({ judgments: [
    { field: "units", equivalent: false, reason: "The units differ." },
  ] }));
  const definitionJudge = new ModelDefinitionJudge(runtime, "judge", "session-1");
  const { result } = await evaluate(
    document([numeric("latency", "Latency", ["小时"])]),
    document([], [numeric("latency", "Latency", ["分钟"])]),
    undefined,
    noSemanticMatches,
    definitionJudge,
  );

  assert.deepEqual(new Set(result.failures.map((item) => item.diff_type)), new Set(["wrong_kind", "wrong_definition"]));
});

test("definition judge fails closed and preserves rule diffs on LLM exception or malformed output", async () => {
  const gold = numeric("latency", "Latency", ["小时"]);
  const pred = numeric("response_time", "Latency", ["分钟"]);
  const expectedDiffs = fieldDiffs({
    gold: { ref: "criteria:latency", kind: "criteria", item: gold },
    pred: { ref: "criteria:response_time", kind: "criteria", item: pred },
    method: "id",
  });

  for (const response of [new Error("provider unavailable"), JSON.stringify({ judgments: [{ field: "units", equivalent: "yes" }] })]) {
    const { runtime } = fakeDefinitionRuntime(response);
    const judge = new ModelDefinitionJudge(runtime, "judge", "session-1");
    const result = await judge.judge(definitionInput(gold, pred));
    assert.deepEqual(result.rule_diffs, expectedDiffs);
    assert.deepEqual(result.final_diffs, expectedDiffs);
    assert.deepEqual(result.judgments.map((item) => item.equivalent), [false]);
  }
});

test("missing and extra attribution is market-only with or without base", async () => {
  const gold = document([numeric("latency")]);
  const extra = categorical("color");

  for (const base of [undefined, document([gold.criteria[0]!], [extra])]) {
    const missing = await evaluate(gold, document(), base);
    const missingFailure = missing.result.failures[0];
    assert.equal(missingFailure?.diff_type, "missing");
    assert.equal(missingFailure?.root_cause, "market_error");
    assert.equal(missingFailure?.earliest_divergence, "market");
    assert.equal(missingFailure?.repair_target, "market-agent prompt / market-alignment skill");

    const extraResult = await evaluate(document(), document([], [extra]), base);
    const extraFailure = extraResult.result.failures[0];
    assert.equal(extraFailure?.diff_type, "extra");
    assert.equal(extraFailure?.root_cause, "market_error");
    assert.equal(extraFailure?.earliest_divergence, "market");
    assert.equal(extraFailure?.repair_target, "market-agent prompt / market-alignment skill");
  }
});

test("taxonomy node mismatch fails before matching or telemetry", async () => {
  const telemetry = new MockTelemetry();
  let matcherCalled = false;
  await assert.rejects(() => runEvaluation({
    caseId: "generic",
    sessionId: "session-1",
    gold: document(),
    prediction: document([], [], { id: "99", name: "Other", path: ["Other"] }),
  }, { async match() { matcherCalled = true; return []; } }, telemetry), /Taxonomy node mismatch/);
  assert.equal(matcherCalled, false);
  assert.equal(telemetry.benchmarkInputs.length, 0);
});

test("Langfuse telemetry emits Session Score and failure observation payloads without network calls", async () => {
  const observations: Array<{ name: string; attributes: any; sessionId?: string; rootTrace?: any }> = [];
  const tracing = {
    enabled: true,
    current() { return undefined; },
    context() { return undefined; },
    startObservation() { return undefined; },
    runInScope(_observation: unknown, fn: () => unknown) { return fn(); },
    async withObservation(name: string, _type: string, attributes: any, fn: (observation: any) => Promise<unknown>, sessionId?: string, rootTrace?: any) {
      const updates: unknown[] = [];
      observations.push({ name, attributes: { ...attributes, updates }, sessionId, rootTrace });
      return fn({ update(value: unknown) { updates.push(value); } });
    },
    async withRemoteObservation() { throw new Error("unused"); },
    async flush() {},
    async shutdown() {},
  };
  const capturedScores: SessionScorePayload[][] = [];
  const writer: SessionScoreWriter = {
    async write(scores) { capturedScores.push(scores); },
    async flush() {},
    async close() {},
  };
  const telemetry = new LangfuseEvalTelemetry(tracing as any, writer);
  const { runtime, calls } = fakeDefinitionRuntime(JSON.stringify({ judgments: [
    { field: "units", equivalent: false, reason: "小时 and 分钟 are different units." },
  ] }));
  const definitionJudge = new ModelDefinitionJudge(runtime, "judge", "real-session");
  const result = await runEvaluation({
    caseId: "generic",
    sessionId: "real-session",
    gold: document([numeric("latency", "Latency", ["小时"]), numeric("missing")]),
    prediction: marketPrediction(document([numeric("response_time", "Latency", ["分钟"])])),
  }, noSemanticMatches, telemetry, definitionJudge);

  assert.equal(capturedScores.length, 1);
  assert.equal(capturedScores[0].length, 8);
  assert.ok(capturedScores[0].every((score) => score.sessionId === "real-session" && score.dataType === "NUMERIC"));
  assert.deepEqual(new Set(capturedScores[0].map((score) => score.name)), new Set(Object.keys(result.metrics)));
  const root = observations.find((item) => item.name === "benchmark-eval");
  assert.equal(root?.sessionId, "real-session");
  assert.equal(root?.rootTrace?.name, "benchmark-eval");
  assert.ok(observations.some((item) => item.name === "semantic-match"));
  const failure = observations.find((item) => item.name === "failure-unit");
  assert.equal(failure?.attributes.output.diff_type, "missing");
  assert.ok(Object.hasOwn(failure?.attributes.output ?? {}, "repair_target"));

  assert.equal(calls(), 1);
  const definitionObservation = observations.find((item) => item.name === "definition-judge");
  assert.deepEqual(definitionObservation?.attributes.input.rule_diffs.map((item: FieldDiff) => item.field), ["units"]);
  const definitionOutput = definitionObservation?.attributes.updates.find((item: any) => item.output)?.output;
  assert.deepEqual(Object.keys(definitionOutput ?? {}).sort(), [
    "final_diffs",
    "gold_item",
    "judgments",
    "pred_item",
    "rule_diffs",
  ]);
  assert.equal(definitionOutput?.judgments[0]?.reason, "小时 and 分钟 are different units.");
  assert.doesNotMatch(JSON.stringify(result.failures), /小时 and 分钟 are different units/);

  const exact = document([numeric("exact", "Exact", ["hour"])]);
  await runEvaluation({
    caseId: "generic-exact",
    sessionId: "real-session",
    gold: exact,
    prediction: marketPrediction(structuredClone(exact)),
  }, noSemanticMatches, telemetry, definitionJudge);
  assert.equal(calls(), 1);
  assert.equal(observations.filter((item) => item.name === "definition-judge").length, 1);
});
