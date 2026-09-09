import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { messageText } from "./content.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SemanticMatchCacheItem, TaxonomySemanticMatchCache } from "./semantic-match-cache.ts";

export type SemanticItem = SemanticMatchCacheItem & {
  ref?: string;
  kind?: string;
  [key: string]: unknown;
};

export type SemanticMatchMethod = "id" | "name" | "alias" | "cache" | "llm";

export type SemanticMatchPair<Left extends SemanticItem = SemanticItem, Right extends SemanticItem = SemanticItem> = {
  left: Left;
  right: Right;
  method: SemanticMatchMethod;
};

export type SharedSemanticMatcherOptions = {
  runtime?: ModelRuntime;
  modelId?: string;
  sessionId?: string;
  thinking?: ThinkingLevel;
  cache?: Pick<TaxonomySemanticMatchCache, "lookup">;
};

const SYSTEM_PROMPT = `You match evaluation dimensions for a shopping taxonomy benchmark.

Return JSON only with this exact shape:
{"pairs":[{"gold_ref":"criteria:example","pred_ref":"attribute:example"}]}

Rules:
- Pair items only when they represent the same evaluation dimension.
- Pairing is one-to-one. Each ref may occur at most once.
- Criteria and attributes may be paired across kinds when the dimension is the same.
- Do not compare field correctness and do not infer root cause.
- Omit uncertain pairs. Do not invent refs.`;

export function normalizeSemanticLabel(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function nonEmptyEqual(left: string, right: string): boolean {
  const normalizedLeft = normalizeSemanticLabel(left);
  return !!normalizedLeft && normalizedLeft === normalizeSemanticLabel(right);
}

function aliases(item: SemanticItem): Set<string> {
  return new Set([
    item.name,
    ...(item.aliases ?? []),
  ].map(normalizeSemanticLabel).filter(Boolean));
}

function aliasMatch(left: SemanticItem, right: SemanticItem): boolean {
  const leftAliases = aliases(left);
  return [...aliases(right)].some((label) => leftAliases.has(label));
}

function itemTerms(item: SemanticItem): string[] {
  return [item.id, item.name, ...(item.aliases ?? [])].filter((term): term is string => (
    typeof term === "string" && !!term.trim()
  ));
}

function reference(item: SemanticItem, side: "gold" | "prediction", index: number): string {
  return item.ref?.trim() || `${side}:${index}:${item.id}`;
}

function modelCandidate(item: SemanticItem, side: "gold" | "prediction", index: number): Record<string, unknown> {
  return {
    ref: reference(item, side, index),
    kind: item.kind,
    name: item.name,
    aliases: item.aliases,
    description: item.description,
    type: item.type,
    units: item.units,
    values: item.values,
  };
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Semantic matcher returned no JSON object.");
  return JSON.parse(trimmed.slice(start, end + 1));
}

function parsePairings(value: unknown): Array<{ gold_ref: string; pred_ref: string }> {
  if (!value || typeof value !== "object" || !Array.isArray((value as { pairs?: unknown }).pairs)) {
    throw new Error("Semantic matcher output must contain a pairs array.");
  }
  return (value as { pairs: unknown[] }).pairs.map((pair, index) => {
    if (!pair || typeof pair !== "object") throw new Error(`Semantic matcher pairs[${index}] must be an object.`);
    const { gold_ref, pred_ref } = pair as Record<string, unknown>;
    if (typeof gold_ref !== "string" || typeof pred_ref !== "string") {
      throw new Error(`Semantic matcher pairs[${index}] must contain string refs.`);
    }
    return { gold_ref, pred_ref };
  });
}

function selectDeterministic<Left extends SemanticItem, Right extends SemanticItem>(
  left: readonly Left[],
  right: readonly Right[],
  predicate: (left: Left, right: Right) => boolean,
  method: SemanticMatchMethod,
): { pairs: SemanticMatchPair<Left, Right>[]; left: Left[]; right: Right[] } {
  const pairs: SemanticMatchPair<Left, Right>[] = [];
  const usedLeft = new Set<string>();
  const usedRight = new Set<string>();

  for (const leftItem of left) {
    const leftRef = leftItem.ref ?? leftItem.id;
    if (usedLeft.has(leftRef)) continue;
    const candidates = right.filter((rightItem) => {
      const rightRef = rightItem.ref ?? rightItem.id;
      return !usedRight.has(rightRef) && predicate(leftItem, rightItem);
    });
    if (candidates.length !== 1) continue;
    const rightItem = candidates[0];
    const reverseCandidates = left.filter((candidate) => predicate(candidate, rightItem));
    if (reverseCandidates.length !== 1) continue;
    const rightRef = rightItem.ref ?? rightItem.id;
    usedLeft.add(leftRef);
    usedRight.add(rightRef);
    pairs.push({ left: leftItem, right: rightItem, method });
  }

  return {
    pairs,
    left: left.filter((item) => !usedLeft.has(item.ref ?? item.id)),
    right: right.filter((item) => !usedRight.has(item.ref ?? item.id)),
  };
}

function validateModelPairings(
  pairings: Array<{ gold_ref: string; pred_ref: string }>,
  left: readonly SemanticItem[],
  right: readonly SemanticItem[],
): SemanticMatchPair[] {
  const leftByRef = new Map(left.map((item, index) => [reference(item, "gold", index), item]));
  const rightByRef = new Map(right.map((item, index) => [reference(item, "prediction", index), item]));
  const usedLeft = new Set<string>();
  const usedRight = new Set<string>();
  return pairings.map((pair) => {
    const leftItem = leftByRef.get(pair.gold_ref);
    const rightItem = rightByRef.get(pair.pred_ref);
    if (!leftItem) throw new Error(`Semantic matcher returned unknown gold_ref '${pair.gold_ref}'.`);
    if (!rightItem) throw new Error(`Semantic matcher returned unknown pred_ref '${pair.pred_ref}'.`);
    if (usedLeft.has(pair.gold_ref) || usedRight.has(pair.pred_ref)) {
      throw new Error("Semantic matcher must return one-to-one pairings.");
    }
    usedLeft.add(pair.gold_ref);
    usedRight.add(pair.pred_ref);
    return { left: leftItem, right: rightItem, method: "llm" as const };
  });
}

/**
 * Shared identity-only matcher used by both Market and Eval.
 *
 * It intentionally returns identity matches only. Definition fields remain
 * available to the model as context, but are not judged here.
 */
export class SharedSemanticMatcher {
  private readonly runtime?: ModelRuntime;
  private readonly modelId?: string;
  private readonly sessionId?: string;
  private readonly thinking: ThinkingLevel;
  private readonly cache?: Pick<TaxonomySemanticMatchCache, "lookup">;

  constructor(options: SharedSemanticMatcherOptions = {}) {
    this.runtime = options.runtime;
    this.modelId = options.modelId;
    this.sessionId = options.sessionId;
    this.thinking = options.thinking ?? "off";
    this.cache = options.cache;
  }

  async matchOne<Left extends SemanticItem, Right extends SemanticItem>(
    candidate: Left,
    canonicalItems: readonly Right[],
  ): Promise<SemanticMatchPair<Left, Right> | undefined> {
    const pairs = await this.matchPairs([candidate], canonicalItems);
    return pairs[0];
  }

  async matchPairs<Left extends SemanticItem, Right extends SemanticItem>(
    leftItems: readonly Left[],
    rightItems: readonly Right[],
  ): Promise<SemanticMatchPair<Left, Right>[]> {
    let left = [...leftItems];
    let right = [...rightItems];
    const pairs: SemanticMatchPair<Left, Right>[] = [];

    for (const [predicate, method] of [
      [(leftItem: Left, rightItem: Right) => nonEmptyEqual(leftItem.id, rightItem.id), "id" as const],
      [(leftItem: Left, rightItem: Right) => nonEmptyEqual(leftItem.name, rightItem.name), "name" as const],
      [(leftItem: Left, rightItem: Right) => aliasMatch(leftItem, rightItem), "alias" as const],
    ] as const) {
      const selected = selectDeterministic(left, right, predicate, method);
      pairs.push(...selected.pairs);
      left = selected.left;
      right = selected.right;
    }

    if (this.cache && left.length && right.length) {
      const cachedCandidates = await Promise.all(left.map(async (leftItem) => ({
        leftItem,
        canonicalId: await this.cache!.lookup(leftItem, right),
      })));
      const byCanonicalId = new Map<string, typeof cachedCandidates>();
      for (const candidate of cachedCandidates) {
        if (!candidate.canonicalId) continue;
        const existing = byCanonicalId.get(candidate.canonicalId) ?? [];
        existing.push(candidate);
        byCanonicalId.set(candidate.canonicalId, existing);
      }
      const selectedLeft = new Set<string>();
      const selectedRight = new Set<string>();
      for (const candidate of cachedCandidates) {
        if (!candidate.canonicalId) continue;
        const rightItem = right.find((item) => item.id === candidate.canonicalId);
        const matchingCandidates = byCanonicalId.get(candidate.canonicalId) ?? [];
        if (!rightItem || matchingCandidates.length !== 1) continue;
        const leftRef = candidate.leftItem.ref ?? candidate.leftItem.id;
        const rightRef = rightItem.ref ?? rightItem.id;
        if (selectedLeft.has(leftRef) || selectedRight.has(rightRef)) continue;
        selectedLeft.add(leftRef);
        selectedRight.add(rightRef);
        pairs.push({ left: candidate.leftItem, right: rightItem, method: "cache" });
      }
      left = left.filter((item) => !selectedLeft.has(item.ref ?? item.id));
      right = right.filter((item) => !selectedRight.has(item.ref ?? item.id));
    }

    if (!left.length || !right.length || !this.runtime) return pairs;
    const modelPairings = await this.matchWithModel(left, right);
    pairs.push(...modelPairings as SemanticMatchPair<Left, Right>[]);
    return pairs;
  }

  private async matchWithModel<Left extends SemanticItem, Right extends SemanticItem>(
    left: readonly Left[],
    right: readonly Right[],
  ): Promise<SemanticMatchPair<Left, Right>[]> {
    if (!this.modelId) throw new Error("Semantic matcher modelId is required for LLM fallback.");
    const model = this.runtime!.getModel(this.modelId);
    this.runtime!.ensureThinking(model, this.thinking);
    const response = await this.runtime!.streamSimple(model, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: JSON.stringify({
          gold: left.map((item, index) => modelCandidate(item, "gold", index)),
          prediction: right.map((item, index) => modelCandidate(item, "prediction", index)),
        }),
        timestamp: Date.now(),
      }],
    }, {
      sessionId: this.sessionId,
      ...(this.thinking === "off" ? {} : { reasoning: this.thinking }),
    }).result();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(`Semantic matcher model request failed: ${response.errorMessage ?? response.stopReason}`);
    }
    return validateModelPairings(parsePairings(parseJsonObject(messageText(response))), left, right) as SemanticMatchPair<Left, Right>[];
  }
}

export {
  SharedSemanticMatcher as SemanticIdentityService,
  SharedSemanticMatcher as SemanticMatcher,
};
