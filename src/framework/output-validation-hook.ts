import type { AgentMessage, ShouldStopAfterTurnContext } from "@earendil-works/pi-agent-core";
import { messageText } from "./content.ts";
import { validateJsonSchema } from "./schema.ts";
import { validateWithTrustedValidator, type TrustedValidationResult } from "./output-validator.ts";
import type { PythonConfig, ResolvedAgentProfile } from "./types.ts";

export type TrustedRuntimeContext = Record<string, unknown> | (() => Record<string, unknown>);

export type OutputValidationControllerState = {
  repairCount: number;
  validationSucceeded: boolean;
  validatedValue?: unknown;
  terminalError?: string;
};

export type OutputValidationControllerOptions = {
  profile: ResolvedAgentProfile;
  python: PythonConfig;
  projectRoot: string;
  steer: (message: AgentMessage) => void;
  /** Trusted context for validators; never sourced from model output. */
  runtimeContext?: TrustedRuntimeContext;
  validateTrusted?: (
    validator: NonNullable<ResolvedAgentProfile["outputValidator"]>,
    value: unknown,
    python: PythonConfig,
    projectRoot: string,
    runtimeContext?: Record<string, unknown>,
  ) => Promise<TrustedValidationResult>;
};

export type OutputValidationController = {
  state: OutputValidationControllerState;
  shouldStopAfterTurn: (turn: ShouldStopAfterTurnContext) => Promise<boolean>;
};

function safeStopReason(turn: ShouldStopAfterTurnContext): string {
  const reason = turn.message.stopReason;
  return typeof reason === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(reason) ? reason : "unknown";
}

export function createOutputRepairMessage(error: string): AgentMessage {
  return {
    role: "user",
    content: [{
      type: "text",
      text: `OUTPUT_REPAIR ${JSON.stringify({ errors: [error.slice(0, 1_000)] })}\nReturn the full corrected JSON object only. Do not explain the repair.`,
    }],
    timestamp: Date.now(),
  };
}

export function createOutputValidationController(options: OutputValidationControllerOptions): OutputValidationController {
  const state: OutputValidationControllerState = { repairCount: 0, validationSucceeded: false };
  const validator = options.validateTrusted ?? ((config, value, python, projectRoot, runtimeContext) => (
    validateWithTrustedValidator(config, value, python, projectRoot, undefined, runtimeContext)
  ));
  const maxRepairs = Math.max(0, Math.min(3, options.profile.outputValidator?.maxOutputRepairs ?? 0));

  const fail = (error: string): boolean => {
    const safeError = error.slice(0, 1_000);
    if (state.repairCount < maxRepairs) {
      state.repairCount += 1;
      try {
        options.steer(createOutputRepairMessage(safeError));
      } catch (repairError) {
        state.terminalError = `Unable to queue output repair: ${repairError instanceof Error ? repairError.message : String(repairError)}`;
        return true;
      }
      return false;
    }
    state.terminalError = `Subagent '${options.profile.id}' output validation failed: ${safeError}`;
    return true;
  };

  const shouldStopAfterTurn = async (turn: ShouldStopAfterTurnContext): Promise<boolean> => {
    // Assistant turns that contain tool calls are intermediate and must not be
    // validated as final JSON.
    if (turn.message.content.some((part) => part.type === "toolCall")) return false;
    if (!options.profile.outputSchema) return true;
    try {
      const text = messageText(turn.message).trim();
      let candidate: unknown;
      try {
        candidate = JSON.parse(text);
      } catch {
        return fail(`$ must be valid JSON (stop_reason=${safeStopReason(turn)}, chars=${text.length})`);
      }
      const basic = validateJsonSchema(options.profile.outputSchema, candidate);
      if (!basic.valid) return fail(basic.error);
      if (options.profile.outputValidator) {
        const context = typeof options.runtimeContext === "function"
          ? options.runtimeContext()
          : options.runtimeContext;
        const trusted = await validator(options.profile.outputValidator, candidate, options.python, options.projectRoot, context);
        if (!trusted.valid) return fail(trusted.error);
        state.validatedValue = trusted.value ?? candidate;
      } else {
        state.validatedValue = candidate;
      }
      state.validationSucceeded = true;
      return true;
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  };

  return { state, shouldStopAfterTurn };
}
