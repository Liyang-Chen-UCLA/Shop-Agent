import {
  createAssistantMessageEventStream,
  createModels,
  getSupportedThinkingLevels,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type Models,
  type ProviderHeaders,
} from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { NoopTracing, sanitizeTracePayload, type TraceObservation, type Tracing } from "./tracing/index.ts";
import { mapCost, mapUsage } from "./tracing/usage.ts";

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

function tracedContext(context: Context): unknown {
  return sanitizeTracePayload({
    systemPrompt: context.systemPrompt,
    messages: context.messages,
    tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })),
  });
}

function tracedOutput(message: AssistantMessage): unknown {
  return sanitizeTracePayload({
    role: message.role,
    content: message.content.filter((item) => item.type !== "thinking"),
  });
}

function finishGeneration(observation: TraceObservation | undefined, event: Extract<AssistantMessageEvent, { type: "done" | "error" }>, firstTokenAt?: Date): void {
  const message = event.type === "done" ? event.message : event.error;
  const aborted = message.stopReason === "aborted";
  observation?.update({
    output: tracedOutput(message),
    ...(firstTokenAt ? { completionStartTime: firstTokenAt } : {}),
    usageDetails: mapUsage(message.usage),
    costDetails: mapCost(message.usage),
    level: event.type === "error" ? (aborted ? "WARNING" : "ERROR") : "DEFAULT",
    statusMessage: message.errorMessage ?? message.stopReason,
    metadata: {
      stopReason: message.stopReason,
      responseModel: message.responseModel,
      responseId: message.responseId,
      cacheWrite1hTokens: message.usage.cacheWrite1h,
      outcome: aborted ? "aborted" : event.type === "error" ? "error" : "success",
    },
  });
  if (event.type === "error") observation?.fail?.(message.errorMessage ?? message.stopReason, aborted);
  observation?.end();
}

function failedMessage(model: Model<any>, error: unknown, latest?: AssistantMessage): AssistantMessage {
  return {
    ...(latest ?? {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
    }),
    stopReason: "error",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

export function createModelRuntime(tracing: Tracing = new NoopTracing()): ModelRuntime {
  const models = createModels();
  models.setProvider(opencodeGoProvider());

  const streamSimple: Models["streamSimple"] = (model, context, options) => {
    const transformHeaders = options?.transformHeaders;
    const sessionId = options?.sessionId;

    const request = () => models.streamSimple(model, context, {
      ...options,
      transformHeaders: async (headers) => {
        const transformedHeaders = transformHeaders ? await transformHeaders(headers) : headers;
        if (model.provider !== "opencode-go" || !sessionId) return transformedHeaders;
        return injectOpenCodeSessionHeaders(transformedHeaders, sessionId);
      },
    });
    if (!tracing.current()) return request();

    const observation = tracing.startObservation("model-request", "generation", {
      model: model.id,
      input: tracedContext(context),
      modelParameters: {
        ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        ...(options?.reasoning === undefined ? {} : { reasoning: options.reasoning }),
      },
      metadata: {
        provider: model.provider,
        api: model.api,
        sessionId,
        maxRetries: options?.maxRetries,
        cacheRetention: options?.cacheRetention,
      },
    });

    let source;
    try {
      source = tracing.runInScope(observation, request);
    } catch (error) {
      observation?.fail?.(error);
      observation?.end();
      throw error;
    }

    if (!observation) return source;
    const output = createAssistantMessageEventStream();
    tracing.runInScope(observation, () => {
      void (async () => {
        let firstTokenAt: Date | undefined;
        let terminal = false;
        let latest: AssistantMessage | undefined;
        try {
          for await (const event of source) {
            latest = "partial" in event ? event.partial : event.type === "done" ? event.message : event.error;
            if (!firstTokenAt && (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")) {
              firstTokenAt = new Date();
            }
            if (event.type === "done" || event.type === "error") {
              terminal = true;
              finishGeneration(observation, event, firstTokenAt);
            }
            output.push(event);
          }
          if (!terminal) {
            const event = {
              type: "error",
              reason: "error",
              error: failedMessage(model, "Model stream ended without a terminal event.", latest),
            } as const;
            finishGeneration(observation, event, firstTokenAt);
            output.push(event);
          }
        } catch (error) {
          const event = { type: "error", reason: "error", error: failedMessage(model, error, latest) } as const;
          finishGeneration(observation, event, firstTokenAt);
          output.push(event);
        }
      })();
    });
    return output;
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
