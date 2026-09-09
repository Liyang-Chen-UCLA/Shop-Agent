import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { messageText } from "./content.ts";
import { validateJsonSchema } from "./schema.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { SemanticMatchCacheItem, TaxonomySemanticMatchCache } from "./semantic-match-cache.ts";
import { ContractStateStore, type ContractItem, type ContractStateKind } from "./contract-state.ts";

export const SEMANTIC_MATCH_TOOL = "semantic_match";

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

export type SemanticMatchToolResult = {
  candidate: ContractItem;
  kind: ContractStateKind;
  matched: boolean;
  canonical_item_id?: string;
  method?: SemanticMatchMethod;
  active_product_id: string;
};

export type SemanticMatchToolOptions = {
  store: ContractStateStore;
  runtime: ModelRuntime;
  modelId: string;
  sessionId: string;
  cache?: Pick<TaxonomySemanticMatchCache, "lookup" | "writeAccepted">;
  getActiveProductId: () => string | undefined;
  onResolved?: (result: SemanticMatchToolResult) => void | Promise<void>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeFieldNames(store: ContractStateStore): Set<string> {
  const properties = store.config.runtimeItemSchema?.properties;
  if (!isRecord(properties)) return new Set();
  return new Set(Object.keys(properties));
}

function definitionOnly(item: ContractItem, runtimeFields: Set<string>): ContractItem {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !runtimeFields.has(key)));
}

function mergedAliases(values: readonly unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const normalized = normalizeSemanticLabel(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

function semanticMatchInputSchema(store: ContractStateStore) {
  return {
    oneOf: ([("criterion" as const), ("attribute" as const)].map((kind) => ({
      type: "object",
      properties: {
        kind: { const: kind },
        item: kind === "criterion" ? store.config.itemSchemas.criterion : store.config.itemSchemas.attribute,
      },
      required: ["kind", "item"],
      additionalProperties: false,
    }))),
  };
}

function textResult(value: SemanticMatchToolResult): { content: [{ type: "text"; text: string }]; details: Record<string, unknown> } {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    details: { tool: SEMANTIC_MATCH_TOOL, ...value },
  };
}

/**
 * Create the Market-facing identity tool. The tool only changes trusted
 * runtime metadata after an accepted identity match; definition changes stay
 * on the complete-item patch path.
 */
export function createSemanticMatchTool(options: SemanticMatchToolOptions): AgentTool<any> {
  const parameters = semanticMatchInputSchema(options.store);
  const matcher = new SharedSemanticMatcher({
    runtime: options.runtime,
    modelId: options.modelId,
    sessionId: options.sessionId,
    thinking: "off",
    cache: options.cache,
  });
  const runtimeFields = runtimeFieldNames(options.store);

  return {
    name: SEMANTIC_MATCH_TOOL,
    label: SEMANTIC_MATCH_TOOL,
    description: "Match one extracted candidate to the current canonical item identity. This never judges or changes the definition.",
    parameters: Type.Unsafe(parameters),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const validation = validateJsonSchema(parameters, params);
      if (!validation.valid) throw new Error(`semantic_match arguments do not match the input schema: ${validation.error}`);
      if (!isRecord(params)) throw new Error("semantic_match arguments must be an object.");
      const kind = params.kind as ContractStateKind;
      const candidate = params.item as ContractItem;
      const activeProductId = options.getActiveProductId();
      if (!activeProductId) throw new Error("semantic_match requires a successfully extracted active product.");

      const state = options.store.get();
      const canonicalItems: SemanticItem[] = [
        ...state.criteria.map((item) => ({ ...definitionOnly(item, runtimeFields), kind: "criterion", ref: `criterion:${String(item.id)}` })),
        ...state.attributes.map((item) => ({ ...definitionOnly(item, runtimeFields), kind: "attribute", ref: `attribute:${String(item.id)}` })),
      ];
      const match = await matcher.matchOne(
        { ...candidate, kind, ref: `${kind}:${String(candidate.id)}` },
        canonicalItems,
      );
      if (!match) {
        const result: SemanticMatchToolResult = {
          candidate: { ...candidate },
          kind,
          matched: false,
          active_product_id: activeProductId,
        };
        await options.onResolved?.(result);
        return textResult(result);
      }

      const canonicalId = String(match.right.id);
      options.store.updateRuntimeItem(canonicalId, (item) => {
        const observed = Array.isArray(item.observed_product_ids)
          ? item.observed_product_ids.filter((value): value is string => typeof value === "string")
          : [];
        return {
          ...item,
          aliases: mergedAliases([
            item.name,
            ...(Array.isArray(item.aliases) ? item.aliases : []),
            candidate.name,
            ...(Array.isArray(candidate.aliases) ? candidate.aliases : []),
          ]),
          observed_product_ids: [...new Set([...observed, activeProductId])],
        };
      });
      await options.cache?.writeAccepted(candidate, match.right);
      const result: SemanticMatchToolResult = {
        candidate: { ...candidate },
        kind,
        matched: true,
        canonical_item_id: canonicalId,
        method: match.method,
        active_product_id: activeProductId,
      };
      await options.onResolved?.(result);
      return textResult(result);
    },
  };
}

export {
  SharedSemanticMatcher as SemanticIdentityService,
  SharedSemanticMatcher as SemanticMatcher,
};
