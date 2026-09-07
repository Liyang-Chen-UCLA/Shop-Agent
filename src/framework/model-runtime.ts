import {
  createModels,
  getSupportedThinkingLevels,
  type Model,
  type Models,
  type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export type ModelRuntime = {
  models: Models;
  streamSimple: Models["streamSimple"];
  getModel(id: string): Model<any>;
  listModels(): readonly Model<any>[];
  resolveThinking(model: Model<any>, level: ThinkingLevel): ThinkingLevel;
  ensureThinking(model: Model<any>, level: ThinkingLevel): void;
};

function injectOpenCodeSessionHeaders(headers: ProviderHeaders, sessionId: string): ProviderHeaders {
  const withoutOpenCodeSessionHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => {
      const normalized = name.toLowerCase();
      return normalized !== "x-opencode-session" && normalized !== "x-opencode-client";
    }),
  );

  return {
    ...withoutOpenCodeSessionHeaders,
    "x-opencode-session": sessionId,
    "x-opencode-client": "pi",
  };
}

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

  const streamSimple: Models["streamSimple"] = (model, context, options) => {
    const transformHeaders = options?.transformHeaders;
    const sessionId = options?.sessionId;

    return models.streamSimple(model, context, {
      ...options,
      transformHeaders: async (headers) => {
        const transformedHeaders = transformHeaders ? await transformHeaders(headers) : headers;
        if (model.provider !== "opencode-go" || !sessionId) return transformedHeaders;
        return injectOpenCodeSessionHeaders(transformedHeaders, sessionId);
      },
    });
  };

  return {
    models,
    streamSimple,
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
