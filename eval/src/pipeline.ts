import { createFailureUnits } from "./attribution.ts";
import { filterObservedMarketItems } from "./loaders.ts";
import { matchDocuments } from "./matching.ts";
import { fieldDiffs, calculateMetrics } from "./metrics.ts";
import type { DefinitionJudge, DefinitionResult, EvalResult, EvalTelemetry, EvaluationInput, SemanticMatcher } from "./types.ts";

export async function runEvaluation(
  input: EvaluationInput,
  matcher: SemanticMatcher,
  telemetry: EvalTelemetry,
  definitionJudge?: DefinitionJudge,
): Promise<EvalResult> {
  const prediction = filterObservedMarketItems(input.prediction);
  const evaluationInput = { ...input, prediction };

  if (evaluationInput.gold.node.id !== evaluationInput.prediction.node.id) {
    throw new Error(
      `Taxonomy node mismatch: gold.node.id '${evaluationInput.gold.node.id}' != prediction.node.id '${evaluationInput.prediction.node.id}'.`,
    );
  }
  if (evaluationInput.base && evaluationInput.base.node.id !== evaluationInput.prediction.node.id) {
    throw new Error(
      `Taxonomy node mismatch: base.node.id '${evaluationInput.base.node.id}' != prediction.node.id '${evaluationInput.prediction.node.id}'.`,
    );
  }

  return telemetry.withBenchmark(evaluationInput, async () => {
    const matched = await matchDocuments(
      evaluationInput.gold,
      evaluationInput.prediction,
      matcher,
      (semanticInput, run) => telemetry.observeSemanticMatch(semanticInput, run),
    );
    const definitionResults: DefinitionResult[] = definitionJudge
      ? await Promise.all(matched.pairings.map(async (pair) => {
        const judgeInput = { gold: pair.gold, pred: pair.pred };
        const ruleDiffs = fieldDiffs(pair);
        if (!ruleDiffs.length) return definitionJudge.judge(judgeInput);
        return telemetry.observeDefinitionJudge(
          judgeInput,
          ruleDiffs,
          () => definitionJudge.judge(judgeInput),
        );
      }))
      : matched.pairings.map((pair) => {
        const ruleDiffs = fieldDiffs(pair);
        return { rule_diffs: ruleDiffs, final_diffs: ruleDiffs, judgments: [] };
      });
    const metrics = calculateMetrics(
      matched.pairings,
      definitionResults,
      { criteria: evaluationInput.gold.criteria.length, attribute: evaluationInput.gold.attributes.length },
      { criteria: evaluationInput.prediction.criteria.length, attribute: evaluationInput.prediction.attributes.length },
    );
    const failures = createFailureUnits(
      matched.pairings,
      matched.unmatchedGold,
      matched.unmatchedPred,
      evaluationInput.base,
      definitionResults,
    );
    const result: EvalResult = {
      case_id: evaluationInput.caseId,
      session_id: evaluationInput.sessionId,
      node: evaluationInput.gold.node,
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
