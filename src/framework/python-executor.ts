import type { OutputValidatorConfig, PythonToolDefinition, PythonToolRuntimeContext } from "./types.ts";
import type { TrustedValidationResult, TrustedValidatorContext } from "./output-validator.ts";

export interface PythonExecutor {
  executeTool(
    definition: PythonToolDefinition,
    callId: string,
    argumentsValue: unknown,
    context?: PythonToolRuntimeContext,
    signal?: AbortSignal,
  ): Promise<unknown>;

  validate(
    validator: OutputValidatorConfig,
    value: unknown,
    context?: TrustedValidatorContext,
    signal?: AbortSignal,
  ): Promise<TrustedValidationResult>;

  close(): Promise<void>;
}
