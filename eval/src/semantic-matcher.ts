import type { ModelRuntime } from "../../src/framework/model-runtime.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { SharedSemanticMatcher, type SemanticItem } from "../../src/framework/semantic-matcher.ts";
import type { TaxonomySemanticMatchCache } from "../../src/framework/semantic-match-cache.ts";
import type { SemanticMatchInput, SemanticMatcher, SemanticPairing } from "./types.ts";

export type ModelSemanticMatcherOptions = {
  cache?: Pick<TaxonomySemanticMatchCache, "lookup">;
};

export class ModelSemanticMatcher implements SemanticMatcher {
  private readonly matcher: SharedSemanticMatcher;

  constructor(
    runtime: ModelRuntime,
    modelId: string,
    sessionId: string,
    thinking: ThinkingLevel = "off",
    options: ModelSemanticMatcherOptions = {},
  ) {
    this.matcher = new SharedSemanticMatcher({
      runtime,
      modelId,
      sessionId,
      thinking,
      cache: options.cache,
    });
  }

  async match(input: SemanticMatchInput): Promise<SemanticPairing[]> {
    const gold = input.gold.map(({ ref, kind, item }) => ({
      ...item,
      ref,
      kind,
    } satisfies SemanticItem));
    const prediction = input.pred.map(({ ref, kind, item }) => ({
      ...item,
      ref,
      kind,
    } satisfies SemanticItem));
    const pairings = await this.matcher.matchPairs(gold, prediction);
    return pairings.map((pair) => ({
      gold_ref: pair.left.ref!,
      pred_ref: pair.right.ref!,
    }));
  }
}
