import type { ObservationAttributes, ObservationType, RootTraceOptions, TraceContext, TraceObservation, Tracing } from "./index.ts";

export class NoopTracing implements Tracing {
  readonly enabled = false;

  current(): TraceObservation | undefined { return undefined; }
  context(_sessionId: string): TraceContext | undefined { return undefined; }
  startObservation(_name: string, _type: ObservationType, _attributes: ObservationAttributes): TraceObservation | undefined { return undefined; }
  runInScope<T>(_observation: TraceObservation | undefined, fn: () => T): T { return fn(); }
  async withObservation<T>(
    _name: string,
    _type: ObservationType,
    _attributes: ObservationAttributes,
    fn: (observation: TraceObservation | undefined) => T | Promise<T>,
    _sessionId?: string,
    _rootTrace?: RootTraceOptions,
  ): Promise<T> {
    return fn(undefined);
  }
  async withRemoteObservation<T>(
    _name: string,
    _type: ObservationType,
    _attributes: ObservationAttributes,
    _parent: TraceContext,
    fn: (observation: TraceObservation | undefined) => T | Promise<T>,
  ): Promise<T> {
    return fn(undefined);
  }
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}
