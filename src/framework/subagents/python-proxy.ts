import type { Interface } from "node:readline";
import type { PythonExecutor } from "../python-executor.ts";
import type { TrustedValidationResult, TrustedValidatorContext } from "../output-validator.ts";
import type { OutputValidatorConfig, PythonToolDefinition, PythonToolRuntimeContext } from "../types.ts";
import type { ChildEvent, ParentEvent } from "./protocol.ts";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; signal?: AbortSignal; abort?: () => void };

export class ChildPythonProxy implements PythonExecutor {
  private readonly input: Interface;
  private readonly emitEvent: (event: ChildEvent) => void;
  private readonly pending = new Map<string, Pending>();
  private sequence = 0;
  private closed = false;

  constructor(input: Interface, emit: (event: ChildEvent) => void) {
    this.input = input;
    this.emitEvent = emit;
    input.on("line", (line) => this.receive(line));
    input.once("close", () => void this.close());
  }

  private receive(line: string): void {
    let response: ParentEvent;
    try { response = JSON.parse(line) as ParentEvent; } catch { return; }
    if (response.type !== "python_response") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error));
  }

  private request(event: Omit<Extract<ChildEvent, { type: "python_request" }>, "id">, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Child Python proxy is closed."));
    const id = `child-python-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve, reject, signal };
      const abort = () => {
        if (!this.pending.delete(id)) return;
        this.emitEvent({ type: "python_cancel", id });
        reject(new Error("Child Python request was aborted."));
      };
      pending.abort = abort;
      if (signal?.aborted) { reject(new Error("Child Python request was aborted.")); return; }
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, pending);
      this.emitEvent({ ...event, id } as ChildEvent);
    });
  }

  executeTool(definition: PythonToolDefinition, callId: string, argumentsValue: unknown, context?: PythonToolRuntimeContext, signal?: AbortSignal): Promise<unknown> {
    return this.request({ type: "python_request", operation: "tool", tool: definition.name, callId, arguments: argumentsValue, context }, signal);
  }

  async validate(validator: OutputValidatorConfig, value: unknown, context?: TrustedValidatorContext, signal?: AbortSignal): Promise<TrustedValidationResult> {
    try {
      const result = await this.request({ type: "python_request", operation: "validator", validator: validator.id, value, context }, signal);
      return { valid: true, value: result };
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error("Child Python proxy closed."));
    this.pending.clear();
  }
}
