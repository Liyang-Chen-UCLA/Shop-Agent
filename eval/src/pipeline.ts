import { createFailureUnits } from "./attribution.ts";
import { matchDocuments } from "./matching.ts";
import { calculateMetrics } from "./metrics.ts";
import type { EvalResult, EvalTelemetry, EvaluationInput, SemanticMatcher } from "./types.ts";

export async function runEvaluation(
  input: EvaluationInput,
  matcher: SemanticMatcher,
  telemetry: EvalTelemetry,
): Promise<EvalResult> {
  if (input.gold.node.id !== input.prediction.node.id) {
    throw new Error(
      `Taxonomy node mismatch: gold.node.id '${input.gold.node.id}' != prediction.node.id '${input.prediction.node.id}'.`,
    );
  }
  if (input.base && input.base.node.id !== input.prediction.node.id) {
    throw new Error(
      `Taxonomy node mismatch: base.node.id '${input.base.node.id}' != prediction.node.id '${input.prediction.node.id}'.`,
    );
  }

  return telemetry.withBenchmark(input, async () => {
    const matched = await matchDocuments(
      input.gold,
      input.prediction,
      matcher,
      (semanticInput, run) => telemetry.observeSemanticMatch(semanticInput, run),
    );
    const metrics = calculateMetrics(
      matched.pairings,
      { criteria: input.gold.criteria.length, attribute: input.gold.attributes.length },
      { criteria: input.prediction.criteria.length, attribute: input.prediction.attributes.length },
    );
    const failures = createFailureUnits(
      matched.pairings,
      matched.unmatchedGold,
      matched.unmatchedPred,
      input.base,
    );
    const result: EvalResult = {
      case_id: input.caseId,
      session_id: input.sessionId,
      node: input.gold.node,
      metrics,
      pairings: matched.pairings.map((pair) => ({
        gold_ref: pair.gold.ref,
        pred_ref: pair.pred.ref,
        method: pair.method,
      })),
      failures,
    };

    for (const item of failures) await telemetry.recordFailure(item);
    await telemetry.writeSessionScores(result);
    return result;
  });
}
