import type { AgentTool } from "@earendil-works/pi-agent-core";
import { LangfuseTracing } from "./langfuse.ts";
import { NoopTracing } from "./noop.ts";
import { errorMessage, sanitizeTracePayload } from "./sanitize.ts";

export type ObservationType = "span" | "generation" | "agent" | "tool" | "chain";

export type ObservationAttributes = {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
  version?: string;
  environment?: string;
  completionStartTime?: Date;
  model?: string;
  modelParameters?: Record<string, string | number>;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
};

export type TraceContext = { traceId: string; parentSpanId: string; sessionId: string };
export type RootTraceOptions = { name: string; tags?: string[] };

export interface TraceObservation {
  readonly traceId: string;
  readonly spanId: string;
  update(attributes: ObservationAttributes): void;
  fail?(error: unknown, aborted?: boolean): void;
  end(): void;
}

export interface Tracing {
  readonly enabled: boolean;
  current(): TraceObservation | undefined;
  context(sessionId: string): TraceContext | undefined;
  startObservation(name: string, type: ObservationType, attributes: ObservationAttributes): TraceObservation | undefined;
  runInScope<T>(observation: TraceObservation | undefined, fn: () => T): T;
  withObservation<T>(name: string, type: ObservationType, attributes: ObservationAttributes, fn: (observation: TraceObservation | undefined) => T | Promise<T>, sessionId?: string, rootTrace?: RootTraceOptions): Promise<T>;
  withRemoteObservation<T>(name: string, type: ObservationType, attributes: ObservationAttributes, parent: TraceContext, fn: (observation: TraceObservation | undefined) => T | Promise<T>): Promise<T>;
  flush(timeoutMs?: number): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
}

function enabledFromEnvironment(): boolean {
  const value = process.env.LANGFUSE_TRACING_ENABLED?.trim().toLowerCase();
  if (value === "false" || value === "0" || value === "off" || value === "no") return false;
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY?.trim() && process.env.LANGFUSE_SECRET_KEY?.trim());
}

/** Construct tracing only from the process environment; initialization is fail-open. */
export function createTracing(options: { exportMode?: "immediate" | "batched" } = {}): Tracing {
  if (!enabledFromEnvironment()) return new NoopTracing();
  try {
    const baseUrl = process.env.LANGFUSE_BASE_URL?.trim().replace(/\/$/, "");
    return new LangfuseTracing({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY!.trim(),
      secretKey: process.env.LANGFUSE_SECRET_KEY!.trim(),
      baseUrl,
      environment: process.env.LANGFUSE_TRACING_ENVIRONMENT?.trim() || undefined,
      release: process.env.LANGFUSE_RELEASE?.trim() || undefined,
      exportMode: options.exportMode,
    });
  } catch {
    return new NoopTracing();
  }
}

/** Wrap LLM-visible tools at their real execute boundary. */
export function traceTools<T extends AgentTool<any>>(tools: T[], tracing: Tracing): T[] {
  return tools.map((tool) => ({
    ...tool,
    async execute(toolCallId: string, args: unknown, signal?: AbortSignal, onUpdate?: unknown) {
      const delegateLifecycle = tool.name === "delegate_agent";
      if (delegateLifecycle) return tool.execute(toolCallId, args as never, signal, onUpdate as never);
      if (!tracing.current()) return tool.execute(toolCallId, args as never, signal, onUpdate as never);

      return tracing.withObservation(tool.name.replaceAll("_", "-"), "tool", {
        input: { toolCallId, arguments: sanitizeTracePayload(args) },
      }, async (observation) => {
        try {
          const result = await tool.execute(toolCallId, args as never, signal, onUpdate as never);
          observation?.update({ output: sanitizeTracePayload(result) });
          return result;
        } catch (error) {
          observation?.fail?.(error, Boolean(signal?.aborted));
          observation?.update({ output: { error: errorMessage(error), aborted: Boolean(signal?.aborted) } });
          throw error;
        }
      });
    },
  } as T));
}

export { NoopTracing } from "./noop.ts";
export { sanitizeTracePayload } from "./sanitize.ts";
export { mapCost, mapUsage } from "./usage.ts";
