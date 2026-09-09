import { messageText } from "../../src/framework/content.ts";
import type { ModelRuntime } from "../../src/framework/model-runtime.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { fieldDiffs } from "./metrics.ts";
import type {
  DefinitionFieldJudgment,
  DefinitionJudge,
  DefinitionJudgeInput,
  DefinitionResult,
  FieldDiff,
  ItemPairing,
} from "./types.ts";

const SYSTEM_PROMPT = `You judge semantic equivalence of definition fields for an already-paired shopping evaluation item.

Return JSON only with this exact shape:
{"judgments":[{"field":"units","equivalent":true,"reason":"小时 and hour name the same unit"}]}

Rules:
- The two items are already paired. Never decide whether they should be paired.
- Judge only the fields listed in rule_diffs.
- Return exactly one judgment for every listed field, with no missing, duplicate, or invented fields.
- equivalent=true means the two field values have the same semantic meaning even if their wording or spelling differs.
- For example, 小时 and hour are equivalent units, while 小时 and 分钟 are not.
- A reason is required for every judgment. Keep it concise and grounded in the supplied values.`;

const DEFINITION_FIELDS = new Set<FieldDiff["field"]>([
  "type",
  "direction",
  "units",
  "values",
  "value_domain",
]);

function isDefinitionField(value: unknown): value is FieldDiff["field"] {
  return typeof value === "string" && DEFINITION_FIELDS.has(value as FieldDiff["field"]);
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Definition judge returned no JSON object.");
  return JSON.parse(trimmed.slice(start, end + 1));
}

function parseJudgments(value: unknown, ruleDiffs: readonly FieldDiff[]): DefinitionFieldJudgment[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { judgments?: unknown }).judgments)) {
    throw new Error("Definition judge output must contain a judgments array.");
  }

  const rawJudgments = (value as { judgments: unknown[] }).judgments;
  if (rawJudgments.length !== ruleDiffs.length) {
    throw new Error("Definition judge must return exactly one judgment per rule diff.");
  }

  const expectedFields = new Set(ruleDiffs.map((item) => item.field));
  const seenFields = new Set<FieldDiff["field"]>();
  for (const [index, raw] of rawJudgments.entries()) {
    if (!raw || typeof raw !== "object") throw new Error(`Definition judge judgments[${index}] must be an object.`);
    const candidate = raw as Record<string, unknown>;
    if (!isDefinitionField(candidate.field) || !expectedFields.has(candidate.field)) {
      throw new Error(`Definition judge judgments[${index}] contains an unexpected field.`);
    }
    if (seenFields.has(candidate.field)) {
      throw new Error(`Definition judge returned a duplicate judgment for '${candidate.field}'.`);
    }
    if (typeof candidate.equivalent !== "boolean") {
      throw new Error(`Definition judge judgments[${index}].equivalent must be boolean.`);
    }
    if (typeof candidate.reason !== "string" || !candidate.reason.trim()) {
      throw new Error(`Definition judge judgments[${index}].reason must be a non-empty string.`);
    }
    seenFields.add(candidate.field);
  }
  if (seenFields.size !== expectedFields.size) {
    throw new Error("Definition judge omitted a rule diff field.");
  }

  const byField = new Map(
    rawJudgments.map((raw) => {
      const candidate = raw as Record<string, unknown>;
      return [candidate.field as FieldDiff["field"], {
        field: candidate.field as FieldDiff["field"],
        equivalent: candidate.equivalent as boolean,
        reason: (candidate.reason as string).trim(),
      } satisfies DefinitionFieldJudgment];
    }),
  );
  return ruleDiffs.map((diff) => byField.get(diff.field)!);
}

function itemForPrompt(input: DefinitionJudgeInput, fields: readonly FieldDiff["field"][]): Record<string, unknown> {
  const describe = (item: DefinitionJudgeInput["gold"]) => ({
    ref: item.ref,
    kind: item.kind,
    id: item.item.id,
    name: item.item.name,
    description: item.item.description,
    aliases: item.item.aliases,
    definition: Object.fromEntries(fields.map((field) => [field, item.item[field]])),
  });
  return {
    gold: describe(input.gold),
    prediction: describe(input.pred),
  };
}

function failClosed(ruleDiffs: readonly FieldDiff[]): DefinitionResult {
  return {
    rule_diffs: [...ruleDiffs],
    judgments: ruleDiffs.map((diff) => ({
      field: diff.field,
      equivalent: false,
      reason: "Definition judge failed; the rule diff is retained.",
    })),
  };
}

export class ModelDefinitionJudge implements DefinitionJudge {
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

  async judge(input: DefinitionJudgeInput): Promise<DefinitionResult> {
    const pairing: ItemPairing = { gold: input.gold, pred: input.pred, method: "id" };
    const ruleDiffs = fieldDiffs(pairing);
    if (!ruleDiffs.length) return { rule_diffs: [], judgments: [] };

    try {
      const model = this.runtime.getModel(this.modelId);
      this.runtime.ensureThinking(model, this.thinking);
      const response = await this.runtime.streamSimple(model, {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: JSON.stringify({
            ...itemForPrompt(input, ruleDiffs.map((item) => item.field)),
            rule_diffs: ruleDiffs,
          }),
          timestamp: Date.now(),
        }],
      }, {
        sessionId: this.sessionId,
        ...(this.thinking === "off" ? {} : { reasoning: this.thinking }),
        maxTokens: 2_000,
      }).result();
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        throw new Error(`Definition judge model request failed: ${response.errorMessage ?? response.stopReason}`);
      }
      return {
        rule_diffs: [...ruleDiffs],
        judgments: parseJudgments(parseJsonObject(messageText(response)), ruleDiffs),
      };
    } catch {
      return failClosed(ruleDiffs);
    }
  }
}
