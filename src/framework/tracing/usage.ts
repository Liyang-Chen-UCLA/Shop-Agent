import type { Usage } from "@earendil-works/pi-ai";

export type LangfuseUsage = {
  input: number;
  output: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_reasoning_tokens?: number;
  total: number;
};

export type LangfuseCost = {
  input?: number;
  output?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_reasoning_tokens?: number;
  total: number;
};

/** Pi output includes reasoning; Langfuse flat usage buckets must be exclusive. */
export function mapUsage(usage: Usage): LangfuseUsage {
  const reasoning = usage.reasoning ?? 0;
  const canSplitReasoning = reasoning > 0 && reasoning <= usage.output;
  return {
    input: Math.max(0, usage.input),
    output: Math.max(0, canSplitReasoning ? usage.output - reasoning : usage.output),
    ...(usage.cacheRead > 0 ? { cache_read_input_tokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cache_creation_input_tokens: usage.cacheWrite } : {}),
    ...(canSplitReasoning ? { output_reasoning_tokens: reasoning } : {}),
    total: Math.max(0, usage.totalTokens),
  };
}

/** Pi already calculates provider/model cost; preserve its exact total. */
export function mapCost(usage: Usage): LangfuseCost {
  const reasoning = usage.reasoning ?? 0;
  const canSplitReasoning = reasoning > 0 && reasoning <= usage.output;
  const reasoningCost = canSplitReasoning ? usage.cost.output * (reasoning / usage.output) : 0;
  const visibleOutputCost = Math.max(0, usage.cost.output - reasoningCost);
  return {
    ...(usage.cost.input > 0 ? { input: usage.cost.input } : {}),
    ...(visibleOutputCost > 0 ? { output: visibleOutputCost } : {}),
    ...(reasoningCost > 0 ? { output_reasoning_tokens: reasoningCost } : {}),
    ...(usage.cost.cacheRead > 0 ? { cache_read_input_tokens: usage.cost.cacheRead } : {}),
    ...(usage.cost.cacheWrite > 0 ? { cache_creation_input_tokens: usage.cost.cacheWrite } : {}),
    total: Math.max(0, usage.cost.total),
  };
}
