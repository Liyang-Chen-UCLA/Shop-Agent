import {
  createModels,
  getSupportedThinkingLevels,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export type ModelRuntime = {
  models: Models;
  getModel(id: string): Model<any>;
  listModels(): readonly Model<any>[];
  resolveThinking(model: Model<any>, level: ThinkingLevel): ThinkingLevel;
  ensureThinking(model: Model<any>, level: ThinkingLevel): void;
};

/**
 * Resolve a persisted thinking level for a target model without reducing it
 * while a higher supported level is available.
 */
export function resolveThinking(model: Model<any>, level: ThinkingLevel): ThinkingLevel {
  const supported = getSupportedThinkingLevels(model) as ThinkingLevel[];
  if (supported.includes(level)) return level;

  const requestedIndex = THINKING_LEVELS.indexOf(level);
  for (let index = requestedIndex + 1; index < THINKING_LEVELS.length; index += 1) {
    const candidate = THINKING_LEVELS[index];
    if (supported.includes(candidate)) return candidate;
  }

  for (let index = THINKING_LEVELS.length - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVELS[index];
    if (supported.includes(candidate)) return candidate;
  }

  throw new Error(`${model.id} does not support any thinking level.`);
}

export function createModelRuntime(): ModelRuntime {
  const models = createModels();
  models.setProvider(opencodeGoProvider());

  return {
    models,
    getModel(id: string) {
      const model = models.getModel("opencode-go", id);
      if (!model) throw new Error(`Unknown OpenCode Go model: ${id}`);
      return model;
    },
    listModels() {
      return models.getModels("opencode-go");
    },
    resolveThinking,
    ensureThinking(model, level) {
      const supported = getSupportedThinkingLevels(model);
      if (!supported.includes(level)) {
        throw new Error(`${model.id} does not support thinking level '${level}'. Supported: ${supported.join(", ")}`);
      }
    },
  };
}

export async function checkOpenCodeAuth(runtime: ModelRuntime): Promise<void> {
  const auth = await runtime.models.checkAuth("opencode-go");
  if (!auth) {
    throw new Error("OPENCODE_API_KEY is not configured in the system environment.");
  }
}
