import { fieldDiffs } from "./metrics.ts";
import { findRuleMatch, flattenItems } from "./matching.ts";
import type {
  CriteriaDocument,
  DiffType,
  EarliestDivergence,
  EvaluatedItem,
  FailureUnit,
  FieldDiff,
  ItemPairing,
  RepairTarget,
  RootCause,
} from "./types.ts";

function snapshot(value: EvaluatedItem | undefined): FailureUnit["gold_item"] {
  return value ? { ...value.item, kind: value.kind } : null;
}

function repairTarget(rootCause: RootCause): RepairTarget {
  switch (rootCause) {
    case "route_error": return "route prompt / taxonomy tools";
    case "criteria_error": return "criteria-agent prompt / research policy";
    case "market_error": return "market-agent prompt / market-alignment skill";
    case "unresolved": return null;
  }
}

function divergence(rootCause: RootCause): EarliestDivergence {
  switch (rootCause) {
    case "route_error": return "route";
    case "criteria_error": return "criteria";
    case "market_error": return "market";
    case "unresolved": return "unresolved";
  }
}

function failure(
  diffType: DiffType,
  gold: EvaluatedItem | undefined,
  pred: EvaluatedItem | undefined,
  rootCause: RootCause,
  differences?: FieldDiff[],
): FailureUnit {
  return {
    gold_item: snapshot(gold),
    pred_item: snapshot(pred),
    diff_type: diffType,
    ...(differences?.length ? { field_diffs: differences } : {}),
    earliest_divergence: divergence(rootCause),
    root_cause: rootCause,
    repair_target: repairTarget(rootCause),
  };
}

function sameSelectedFields(left: ItemPairing, fields: readonly FieldDiff["field"][]): boolean {
  const differences = new Map(fieldDiffs(left).map((item) => [item.field, item]));
  return fields.every((field) => !differences.has(field));
}

function matchedRootCause(
  pairing: ItemPairing,
  diffType: "wrong_kind" | "wrong_definition",
  differences: FieldDiff[] | undefined,
  baseItems: readonly EvaluatedItem[] | undefined,
): RootCause {
  if (!baseItems) return "unresolved";
  const baseItem = findRuleMatch(pairing.pred, baseItems);
  if (!baseItem) return "market_error";

  if (diffType === "wrong_kind") {
    if (baseItem.kind === pairing.gold.kind) return "market_error";
    if (baseItem.kind === pairing.pred.kind) return "criteria_error";
    return "unresolved";
  }

  const fields = (differences ?? []).map((item) => item.field);
  const goldToBase: ItemPairing = { gold: pairing.gold, pred: baseItem, method: "id" };
  const baseToPred: ItemPairing = { gold: baseItem, pred: pairing.pred, method: "id" };
  if (sameSelectedFields(goldToBase, fields)) return "market_error";
  if (sameSelectedFields(baseToPred, fields)) return "criteria_error";
  return "unresolved";
}

export function createFailureUnits(
  pairings: readonly ItemPairing[],
  unmatchedGold: readonly EvaluatedItem[],
  unmatchedPred: readonly EvaluatedItem[],
  base?: CriteriaDocument,
): FailureUnit[] {
  const failures: FailureUnit[] = [];
  const baseItems = base ? flattenItems(base) : undefined;

  for (const gold of unmatchedGold) {
    failures.push(failure("missing", gold, undefined, "market_error"));
  }

  for (const pred of unmatchedPred) {
    failures.push(failure("extra", undefined, pred, "market_error"));
  }

  for (const pairing of pairings) {
    if (pairing.gold.kind !== pairing.pred.kind) {
      failures.push(failure(
        "wrong_kind",
        pairing.gold,
        pairing.pred,
        matchedRootCause(pairing, "wrong_kind", undefined, baseItems),
      ));
    }
    const differences = fieldDiffs(pairing);
    if (differences.length) {
      failures.push(failure(
        "wrong_definition",
        pairing.gold,
        pairing.pred,
        matchedRootCause(pairing, "wrong_definition", differences, baseItems),
        differences,
      ));
    }
  }

  return failures;
}
