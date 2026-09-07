import type { PythonExecutor } from "./python-executor.ts";
import type { OutputValidatorConfig } from "./types.ts";

export type TrustedValidationResult = { valid: true; value?: unknown } | { valid: false; error: string };
export type TrustedValidatorContext = Record<string, unknown>;

const TRUSTED_VALIDATORS = new Set(["criteria_v1", "market_v1"]);

export async function validateWithTrustedValidator(
  validator: OutputValidatorConfig,
  value: unknown,
  executor: PythonExecutor,
  signal?: AbortSignal,
  context?: TrustedValidatorContext,
): Promise<TrustedValidationResult> {
  if (!TRUSTED_VALIDATORS.has(validator.id)) return { valid: false, error: `Unknown trusted output validator '${validator.id}'.` };
  return executor.validate(validator, value, context, signal);
}

export function listTrustedOutputValidators(): string[] { return [...TRUSTED_VALIDATORS]; }
