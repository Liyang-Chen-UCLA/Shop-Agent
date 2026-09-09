import { isDeepStrictEqual } from "node:util";
import { normalizeLabel } from "./matching.ts";
import type { DefinitionResult, ItemPairing, SessionMetrics } from "./types.ts";

const MATCHED_FIELDS = ["type", "direction", "units", "values", "value_domain"] as const;

function canonicalValue(field: typeof MATCHED_FIELDS[number], value: unknown): unknown {
  if (typeof value === "string") return normalizeLabel(value);
  if ((field === "units" || field === "values") && Array.isArray(value)) {
    return value.map((item) => typeof item === "string" ? normalizeLabel(item) : item)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (Array.isArray(value)) return value.map((item) => canonicalNested(item));
  return canonicalNested(value);
}

function canonicalNested(value: unknown): unknown {
  if (typeof value === "string") return normalizeLabel(value);
  if (Array.isArray(value)) return value.map(canonicalNested);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalNested(item)]),
  );
}

export function fieldDiffs(pairing: ItemPairing): FieldDiff[] {
  const differences: FieldDiff[] = [];
  for (const field of MATCHED_FIELDS) {
    const goldApplicable = Object.hasOwn(pairing.gold.item, field);
    const predApplicable = Object.hasOwn(pairing.pred.item, field);
    if (!goldApplicable && !predApplicable) continue;
    const gold = pairing.gold.item[field];
    const pred = pairing.pred.item[field];
    if (!isDeepStrictEqual(canonicalValue(field, gold), canonicalValue(field, pred))) {
      differences.push({ field, gold: gold ?? null, pred: pred ?? null });
    }
  }
  return differences;
}

function ratio(numerator: number, denominator: number, counterpart: number): number {
  if (denominator > 0) return numerator / denominator;
  return counterpart === 0 ? 1 : 0;
}

function f1(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export function calculateMetrics(
  pairings: readonly ItemPairing[],
  definitionResults: readonly DefinitionResult[],
  goldCounts: { criteria: number; attribute: number },
  predCounts: { criteria: number; attribute: number },
): SessionMetrics {
  const criteriaMatches = pairings.filter((pair) => pair.gold.kind === "criteria" && pair.pred.kind === "criteria").length;
  const attributeMatches = pairings.filter((pair) => pair.gold.kind === "attribute" && pair.pred.kind === "attribute").length;
  const criteriaPrecision = ratio(criteriaMatches, predCounts.criteria, goldCounts.criteria);
  const criteriaRecall = ratio(criteriaMatches, goldCounts.criteria, predCounts.criteria);
  const attributePrecision = ratio(attributeMatches, predCounts.attribute, goldCounts.attribute);
  const attributeRecall = ratio(attributeMatches, goldCounts.attribute, predCounts.attribute);

  let applicableFields = 0;
  let correctFields = 0;
  for (const [index, pairing] of pairings.entries()) {
    const definition = definitionResults[index];
    if (!definition) throw new Error(`Missing definition result for pairing ${index}.`);
    const differences = new Set(definition.final_diffs.map((item) => item.field));
    for (const field of MATCHED_FIELDS) {
      if (!Object.hasOwn(pairing.gold.item, field) && !Object.hasOwn(pairing.pred.item, field)) continue;
      applicableFields += 1;
      if (!differences.has(field)) correctFields += 1;
    }
  }

  return {
    route_correctness: 1,
    criteria_precision: criteriaPrecision,
    criteria_recall: criteriaRecall,
    criteria_f1: f1(criteriaPrecision, criteriaRecall),
    attribute_precision: attributePrecision,
    attribute_recall: attributeRecall,
    attribute_f1: f1(attributePrecision, attributeRecall),
    matched_item_field_accuracy: applicableFields ? correctFields / applicableFields : 0,
  };
}
