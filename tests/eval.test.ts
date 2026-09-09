import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadEvalCase } from "../eval/src/loaders.ts";
import { runEvaluation } from "../eval/src/pipeline.ts";
import { LangfuseEvalTelemetry } from "../eval/src/telemetry.ts";
import type {
  CriteriaDocument,
  EvalResult,
  EvalTelemetry,
  EvaluationInput,
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
  async recordFailure(failure: FailureUnit): Promise<void> { this.failures.push(failure); }
  async writeSessionScores(result: EvalResult): Promise<void> { this.scoreResults.push(result); }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}

const noSemanticMatches: SemanticMatcher = { async match() { return []; } };

async function evaluate(
  gold: CriteriaDocument,
  prediction: CriteriaDocument,
  base?: CriteriaDocument,
  matcher: SemanticMatcher = noSemanticMatches,
): Promise<{ result: EvalResult; telemetry: MockTelemetry }> {
  const telemetry = new MockTelemetry();
  const result = await runEvaluation({
    caseId: "generic",
    sessionId: "session-1",
    gold,
    prediction,
    base,
  }, matcher, telemetry);
  return { result, telemetry };
}

test("loads any safe eval/cases/<case-id>/gold.json path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shop-agent-eval-case-"));
  try {
    const directory = path.join(root, "eval", "cases", "camera");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "gold.json"), JSON.stringify(document([numeric("latency")])), "utf8");
    const loaded = await loadEvalCase(root, "camera");
    assert.equal(loaded.node.id, NODE.id);
    assert.equal(loaded.criteria[0].id, "latency");
    await assert.rejects(() => loadEvalCase(root, "../escape"), /safe case id/);
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
  const { result } = await evaluate(document(), document([], [categorical("color")]));
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].diff_type, "extra");
  assert.equal(result.metrics.attribute_precision, 0);
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
  const result = await runEvaluation({
    caseId: "generic",
    sessionId: "real-session",
    gold: document([numeric("latency")]),
    prediction: document(),
  }, noSemanticMatches, telemetry);

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
});
