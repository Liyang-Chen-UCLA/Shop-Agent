import { AsyncLocalStorage } from "node:async_hooks";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  LangfuseOtelSpanAttributes,
  setLangfuseTracerProvider,
  startObservation,
  type LangfuseObservation,
} from "@langfuse/tracing";
import { AlwaysOnSampler, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SpanStatusCode, TraceFlags, type SpanContext } from "@opentelemetry/api";
import { errorMessage, sanitizeTracePayload } from "./sanitize.ts";
import type { ObservationAttributes, ObservationType, RootTraceOptions, TraceContext, TraceObservation, Tracing } from "./index.ts";

const FLUSH_TIMEOUT_MS = 3_000;

function bounded(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]).catch(() => undefined).finally(() => { if (timer) clearTimeout(timer); });
}

class LangfuseObservationHandle implements TraceObservation {
  private ended = false;
  private failureMarked = false;
  readonly raw: LangfuseObservation;
  readonly sessionId?: string;
  readonly traceName: string;
  readonly traceTags: string[];

  constructor(raw: LangfuseObservation, sessionId?: string, traceName = "shop-turn", traceTags = ["shop-agent"]) {
    this.raw = raw;
    this.sessionId = sessionId;
    this.traceName = traceName;
    this.traceTags = traceTags;
    try {
      raw.otelSpan.setAttributes({
        [LangfuseOtelSpanAttributes.TRACE_NAME]: traceName,
        ...(sessionId ? { [LangfuseOtelSpanAttributes.TRACE_SESSION_ID]: sessionId } : {}),
        ...(traceTags.length ? { [LangfuseOtelSpanAttributes.TRACE_TAGS]: traceTags } : {}),
      });
    } catch {
      // Tracing is deliberately fail-open.
    }
  }
  get traceId(): string { return this.raw.traceId; }
  get spanId(): string { return this.raw.id; }

  update(attributes: ObservationAttributes): void {
    try {
      this.raw.updateOtelSpanAttributes(sanitizeAttributes(attributes));
    } catch {
      // Tracing is deliberately fail-open.
    }
  }

  fail(error: unknown, aborted = false): void {
    if (this.failureMarked) return;
    this.failureMarked = true;
    try {
      const message = errorMessage(error);
      this.raw.updateOtelSpanAttributes({
        level: aborted ? "WARNING" : "ERROR",
        statusMessage: aborted ? `aborted: ${message}` : message,
      });
      if (!aborted) this.raw.otelSpan.setStatus({ code: SpanStatusCode.ERROR, message });
    } catch {
      // Tracing is deliberately fail-open.
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    try { this.raw.end(); } catch { /* fail-open */ }
  }
}

function sanitizeAttributes(attributes: ObservationAttributes): ObservationAttributes {
  return {
    ...attributes,
    ...(attributes.input === undefined ? {} : { input: sanitizeTracePayload(attributes.input) }),
    ...(attributes.output === undefined ? {} : { output: sanitizeTracePayload(attributes.output) }),
    ...(attributes.metadata === undefined ? {} : { metadata: sanitizeTracePayload(attributes.metadata) as Record<string, unknown> }),
    ...(attributes.statusMessage === undefined ? {} : { statusMessage: errorMessage(attributes.statusMessage) }),
  };
}

function redactCredentialLiterals(value: unknown, secrets: readonly string[]): unknown {
  const redact = (text: string) => secrets.reduce((result, secret) => secret ? result.replaceAll(secret, "[REDACTED]") : result, text);
  if (typeof value === "string") return redact(value);
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "string" ? redact(item) : item));
  } catch {
    return "[UNSERIALIZABLE]";
  }
}

export class LangfuseTracing implements Tracing {
  readonly enabled = true;
  private readonly storage = new AsyncLocalStorage<LangfuseObservationHandle>();
  private readonly processor: LangfuseSpanProcessor;
  private readonly provider: NodeTracerProvider;
  private closed = false;

  constructor(config: {
    publicKey: string;
    secretKey: string;
    baseUrl?: string;
    environment?: string;
    release?: string;
    exportMode?: "immediate" | "batched";
  }) {
    this.processor = new LangfuseSpanProcessor({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(config.environment ? { environment: config.environment } : {}),
      ...(config.release ? { release: config.release } : {}),
      ...(config.exportMode ? { exportMode: config.exportMode } : {}),
      mask: ({ data }) => {
        const sanitized = redactCredentialLiterals(
          sanitizeTracePayload(data),
          [config.publicKey, config.secretKey],
        );
        return typeof data === "string" && typeof sanitized !== "string" ? JSON.stringify(sanitized) : sanitized;
      },
    });
    this.provider = new NodeTracerProvider({
      spanProcessors: [this.processor],
      sampler: new AlwaysOnSampler(),
      spanLimits: { attributeValueLengthLimit: Infinity, attributeCountLimit: Infinity },
    });
    setLangfuseTracerProvider(this.provider);
  }

  current(): TraceObservation | undefined { return this.storage.getStore(); }

  context(sessionId: string): TraceContext | undefined {
    const current = this.storage.getStore();
    return current ? { traceId: current.traceId, parentSpanId: current.spanId, sessionId } : undefined;
  }

  startObservation(name: string, type: ObservationType, attributes: ObservationAttributes): TraceObservation | undefined {
    try {
      const parent = this.storage.getStore();
      const raw = parent
        ? parent.raw.startObservation(name, sanitizeAttributes(attributes) as never, { asType: type } as never)
        : startObservation(name, sanitizeAttributes(attributes) as never, { asType: type } as never);
      return new LangfuseObservationHandle(raw, parent?.sessionId, parent?.traceName, parent?.traceTags);
    } catch {
      return undefined;
    }
  }

  runInScope<T>(observation: TraceObservation | undefined, fn: () => T): T {
    return observation instanceof LangfuseObservationHandle ? this.storage.run(observation, fn) : fn();
  }

  async withObservation<T>(
    name: string,
    type: ObservationType,
    attributes: ObservationAttributes,
    fn: (observation: TraceObservation | undefined) => T | Promise<T>,
    sessionId?: string,
    rootTrace?: RootTraceOptions,
  ): Promise<T> {
    return this.run(name, type, attributes, this.storage.getStore(), undefined, fn, sessionId, rootTrace);
  }

  async withRemoteObservation<T>(
    name: string,
    type: ObservationType,
    attributes: ObservationAttributes,
    parent: TraceContext,
    fn: (observation: TraceObservation | undefined) => T | Promise<T>,
  ): Promise<T> {
    const remote: SpanContext = {
      traceId: parent.traceId,
      spanId: parent.parentSpanId,
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
    return this.run(name, type, attributes, undefined, remote, fn, parent.sessionId);
  }

  private async run<T>(
    name: string,
    type: ObservationType,
    attributes: ObservationAttributes,
    parent: LangfuseObservationHandle | undefined,
    remote: SpanContext | undefined,
    fn: (observation: TraceObservation | undefined) => T | Promise<T>,
    sessionId?: string,
    rootTrace?: RootTraceOptions,
  ): Promise<T> {
    let handle: LangfuseObservationHandle | undefined;
    try {
      const create = () => {
        const raw = parent
          ? parent.raw.startObservation(name, sanitizeAttributes(attributes) as never, { asType: type } as never)
          : startObservation(name, sanitizeAttributes(attributes) as never, {
              asType: type,
              ...(remote ? { parentSpanContext: remote } : {}),
            } as never);
        return new LangfuseObservationHandle(
          raw,
          sessionId ?? parent?.sessionId,
          rootTrace?.name ?? parent?.traceName,
          rootTrace?.tags ?? parent?.traceTags,
        );
      };
      handle = create();
    } catch {
      return fn(undefined);
    }

    try {
      return await this.storage.run(handle, () => fn(handle));
    } catch (error) {
      handle.fail(error);
      handle.update({ output: { error: errorMessage(error) } });
      throw error;
    } finally {
      handle.end();
    }
  }

  async flush(timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
    if (this.closed) return;
    try { await bounded(this.processor.forceFlush(), timeoutMs); } catch { /* fail-open */ }
  }

  async shutdown(timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { await bounded(this.provider.shutdown(), timeoutMs); } catch { /* fail-open */ }
  }
}
