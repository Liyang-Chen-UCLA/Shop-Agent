import { messageText } from "../../src/framework/content.ts";
import type { ModelRuntime } from "../../src/framework/model-runtime.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SemanticMatchInput, SemanticMatcher, SemanticPairing } from "./types.ts";

const SYSTEM_PROMPT = `You match evaluation dimensions for a shopping taxonomy benchmark.

Return JSON only with this exact shape:
{"pairs":[{"gold_ref":"criteria:example","pred_ref":"attribute:example"}]}

Rules:
- Pair items only when they represent the same evaluation dimension.
- Pairing is one-to-one. Each ref may occur at most once.
- Criteria and attributes may be paired across kinds when the dimension is the same.
- Do not compare field correctness and do not infer root cause.
- Omit uncertain pairs. Do not invent refs.`;

function candidate(item: SemanticMatchInput["gold"][number]): Record<string, unknown> {
  return {
    ref: item.ref,
    kind: item.kind,
    name: item.item.name,
    aliases: item.item.aliases,
    description: item.item.description,
    type: item.item.type,
    units: item.item.units,
    values: item.item.values,
  };
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Semantic matcher returned no JSON object.");
  return JSON.parse(trimmed.slice(start, end + 1));
}

function parsePairings(value: unknown): SemanticPairing[] {
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

export class ModelSemanticMatcher implements SemanticMatcher {
  private readonly runtime: ModelRuntime;
  private readonly modelId: string;
  private readonly sessionId: string;
  private readonly thinking: ThinkingLevel;

  constructor(
    runtime: ModelRuntime,
    modelId: string,
    sessionId: string,
    thinking: ThinkingLevel = "off",
  ) {
    this.runtime = runtime;
    this.modelId = modelId;
    this.sessionId = sessionId;
    this.thinking = thinking;
  }

  async match(input: SemanticMatchInput): Promise<SemanticPairing[]> {
    const model = this.runtime.getModel(this.modelId);
    this.runtime.ensureThinking(model, this.thinking);
    const response = await this.runtime.streamSimple(model, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: JSON.stringify({
          gold: input.gold.map(candidate),
          prediction: input.pred.map(candidate),
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
    return parsePairings(parseJsonObject(messageText(response)));
  }
}
