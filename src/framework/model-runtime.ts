import {
  createModels,
  getSupportedThinkingLevels,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type ModelRuntime = {
  models: Models;
  getModel(id: string): Model<any>;
  listModels(): readonly Model<any>[];
  ensureThinking(model: Model<any>, level: ThinkingLevel): void;
};

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
