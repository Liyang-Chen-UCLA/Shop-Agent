import type { AgentTool } from "@earendil-works/pi-agent-core";
import { validateJsonSchema } from "./schema.ts";
import { validateWithTrustedValidator } from "./output-validator.ts";
import type { PythonExecutor } from "./python-executor.ts";
import type { ResolvedAgentProfile } from "./types.ts";

export const SUBMIT_RESULT_TOOL = "submit_result";

export type TerminalOutputState = {
  submitted: boolean;
  validatedValue?: unknown;
};

export type TerminalOutputOptions = {
  python?: PythonExecutor;
  /** Trusted context for the validator; never sourced from tool arguments. */
  runtimeContext?: Record<string, unknown> | (() => Record<string, unknown>);
};

export type TerminalOutputTool = AgentTool<any> & {
  readonly state: TerminalOutputState;
};

/** Create the one framework-owned terminal result tool for a structured agent. */
export function createTerminalOutputTool(
  profile: ResolvedAgentProfile,
  options: TerminalOutputOptions = {},
): TerminalOutputTool | undefined {
  if (!profile.outputSchema) return undefined;

  const state: TerminalOutputState = { submitted: false };
  const tool: TerminalOutputTool = {
    name: SUBMIT_RESULT_TOOL,
    label: SUBMIT_RESULT_TOOL,
    description: "Submit the final structured result for this agent.",
    parameters: profile.outputSchema as AgentTool<any>["parameters"],
    state,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      const schemaValidation = validateJsonSchema(profile.outputSchema!, params);
      if (!schemaValidation.valid) {
        throw new Error(`submit_result arguments do not match the output schema: ${schemaValidation.error}`);
      }

      let validatedValue = params;
      if (profile.outputValidator) {
        if (!options.python) {
          throw new Error(`submit_result requires a Python executor for trusted validator '${profile.outputValidator.id}'.`);
        }
        const runtimeContext = typeof options.runtimeContext === "function"
          ? options.runtimeContext()
          : options.runtimeContext;
        const trusted = await validateWithTrustedValidator(
          profile.outputValidator,
          params,
          options.python,
          signal,
          runtimeContext,
        );
        if (!trusted.valid) {
          throw new Error(`submit_result trusted validator '${profile.outputValidator.id}' rejected the result: ${trusted.error}`);
        }
        if (trusted.value !== undefined) validatedValue = trusted.value;
      }

      state.validatedValue = validatedValue;
      state.submitted = true;
      return {
        content: [{ type: "text", text: "submit_result accepted." }],
        details: { tool: SUBMIT_RESULT_TOOL },
        terminate: true,
      };
    },
  };
  return tool;
}
