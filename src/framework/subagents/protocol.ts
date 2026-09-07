import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { PythonToolDefinition, PythonToolRuntimeContext, ResolvedAgentProfile } from "../types.ts";

export type ChildRequest = {
  runId: string;
  /** Trusted parent session identity used by developer diagnostics. */
  sessionId: string;
  /** Trusted project root; never supplied by the model. */
  projectRoot: string;
  /** Trusted runtime data directory used by narrow persistence tools. */
  dataDirectory: string;
  /** Trusted configured parquet dataset, never model-authored. */
  datasetPath: string;
  /** Trusted configured cap for distinct sampled products. */
  maxDistinctProducts: number;
  task: string;
  profile: ResolvedAgentProfile;
  model: string;
  thinking: ThinkingLevel;
  tools: PythonToolDefinition[];
};

export type ChildEvent =
  | { type: "status"; state: "starting" | "running"; message: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; name: string; args: unknown }
  | { type: "tool_end"; name: string; result: unknown; isError: boolean }
  | { type: "python_request"; id: string; operation: "tool"; tool: string; callId: string; arguments: unknown; context?: PythonToolRuntimeContext }
  | { type: "python_request"; id: string; operation: "validator"; validator: string; value: unknown; context?: Record<string, unknown> }
  | { type: "python_cancel"; id: string }
  | { type: "result"; text: string; value?: unknown; messages: AgentMessage[] }
  | { type: "error"; message: string };

export type ParentEvent =
  | { type: "python_response"; id: string; ok: true; result: unknown }
  | { type: "python_response"; id: string; ok: false; error: string };
