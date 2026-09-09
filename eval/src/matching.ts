import type {
  CriteriaDocument,
  EvaluatedItem,
  ItemPairing,
  MatchMethod,
  SemanticMatchInput,
  SemanticMatcher,
} from "./types.ts";
import { normalizeSemanticLabel } from "../../src/framework/semantic-matcher.ts";

export function normalizeLabel(value: string): string {
  return normalizeSemanticLabel(value);
}

export function flattenItems(document: CriteriaDocument): EvaluatedItem[] {
  return [
    ...document.criteria.map((item) => ({ ref: `criteria:${item.id}`, kind: "criteria" as const, item })),
    ...document.attributes.map((item) => ({ ref: `attribute:${item.id}`, kind: "attribute" as const, item })),
  ];
}

function aliasLabels(item: EvaluatedItem): Set<string> {
  return new Set([item.item.name, ...item.item.aliases].map(normalizeLabel).filter(Boolean));
}

function aliasMatch(gold: EvaluatedItem, pred: EvaluatedItem): boolean {
  const goldLabels = aliasLabels(gold);
  return [...aliasLabels(pred)].some((label) => goldLabels.has(label));
}

function selectDeterministic(
  gold: EvaluatedItem[],
  pred: EvaluatedItem[],
  predicate: (goldItem: EvaluatedItem, predItem: EvaluatedItem) => boolean,
  method: MatchMethod,
): ItemPairing[] {
  const pairs: ItemPairing[] = [];
  const usedPred = new Set<string>();

  for (const goldItem of gold) {
    const candidates = pred.filter((predItem) => !usedPred.has(predItem.ref) && predicate(goldItem, predItem));
    if (candidates.length !== 1) continue;
    const predItem = candidates[0];
    const reverseCandidates = gold.filter((candidate) => predicate(candidate, predItem));
    if (reverseCandidates.length !== 1) continue;
    usedPred.add(predItem.ref);
    pairs.push({ gold: goldItem, pred: predItem, method });
  }

  for (const pair of pairs) {
    const goldIndex = gold.findIndex((item) => item.ref === pair.gold.ref);
    if (goldIndex >= 0) gold.splice(goldIndex, 1);
    const predIndex = pred.findIndex((item) => item.ref === pair.pred.ref);
    if (predIndex >= 0) pred.splice(predIndex, 1);
  }
  return pairs;
}

export type MatchResult = {
  pairings: ItemPairing[];
  unmatchedGold: EvaluatedItem[];
  unmatchedPred: EvaluatedItem[];
  semanticPairings: ItemPairing[];
};

export async function matchDocuments(
  goldDocument: CriteriaDocument,
  predDocument: CriteriaDocument,
  matcher: SemanticMatcher,
  observeSemanticMatch: <T>(input: SemanticMatchInput, run: () => Promise<T>) => Promise<T>,
): Promise<MatchResult> {
  const gold = flattenItems(goldDocument);
  const pred = flattenItems(predDocument);
  const pairings: ItemPairing[] = [];

  pairings.push(...selectDeterministic(
    gold,
    pred,
    (left, right) => normalizeLabel(left.item.id) === normalizeLabel(right.item.id),
    "id",
  ));
  pairings.push(...selectDeterministic(
    gold,
    pred,
    (left, right) => normalizeLabel(left.item.name) === normalizeLabel(right.item.name),
    "name",
  ));
  pairings.push(...selectDeterministic(gold, pred, aliasMatch, "alias"));

  const semanticInput = { gold: [...gold], pred: [...pred] };
  const requested = await observeSemanticMatch(semanticInput, async () => {
    if (!gold.length || !pred.length) return [];
    return matcher.match(semanticInput);
  });

  const goldByRef = new Map(gold.map((item) => [item.ref, item]));
  const predByRef = new Map(pred.map((item) => [item.ref, item]));
  const usedGold = new Set<string>();
  const usedPred = new Set<string>();
  const semanticPairings: ItemPairing[] = [];
  for (const candidate of requested) {
    const goldItem = goldByRef.get(candidate.gold_ref);
    const predItem = predByRef.get(candidate.pred_ref);
    if (!goldItem) throw new Error(`Semantic matcher returned unknown gold_ref '${candidate.gold_ref}'.`);
    if (!predItem) throw new Error(`Semantic matcher returned unknown pred_ref '${candidate.pred_ref}'.`);
    if (usedGold.has(goldItem.ref) || usedPred.has(predItem.ref)) {
      throw new Error("Semantic matcher must return one-to-one pairings.");
    }
    usedGold.add(goldItem.ref);
    usedPred.add(predItem.ref);
    semanticPairings.push({ gold: goldItem, pred: predItem, method: "semantic" });
  }

  pairings.push(...semanticPairings);
  return {
    pairings,
    unmatchedGold: gold.filter((item) => !usedGold.has(item.ref)),
    unmatchedPred: pred.filter((item) => !usedPred.has(item.ref)),
    semanticPairings,
  };
}

/** Rule-only lookup used by the deterministic final → base attribution pass. */
export function findRuleMatch(target: EvaluatedItem, candidates: readonly EvaluatedItem[]): EvaluatedItem | undefined {
  const stages = [
    (item: EvaluatedItem) => normalizeLabel(item.item.id) === normalizeLabel(target.item.id),
    (item: EvaluatedItem) => normalizeLabel(item.item.name) === normalizeLabel(target.item.name),
    (item: EvaluatedItem) => aliasMatch(target, item),
  ];
  for (const stage of stages) {
    const matches = candidates.filter(stage);
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}
