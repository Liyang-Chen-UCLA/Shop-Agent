import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { PythonToolDefinition, PythonToolRuntimeContext, ResolvedAgentProfile, RuntimeLlmConfig } from "../types.ts";
import type { ContractState } from "../contract-state.ts";
import type { TraceContext } from "../tracing/index.ts";

export type TrustedRoute = {
  node_id: string;
  node_name: string;
  node_path: string;
};

export type ChildRequest = {
  /** Stable logical subagent task identity across executions. */
  taskId: string;
  /** Unique identity of this concrete child execution. */
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
  /** Trusted runtime LLM settings used by the child agent's isolated tools. */
  llm: RuntimeLlmConfig;
  task: string;
  profile: ResolvedAgentProfile;
  model: string;
  thinking: ThinkingLevel;
  tools: PythonToolDefinition[];
  /** Trusted snapshot for an opt-in framework-owned contract state. */
  contractState?: ContractState;
  /** Trusted route facts used by framework finalizers; never model-authored. */
  trustedRoute?: TrustedRoute;
  execution: number;
  checkpoint?: SubagentCheckpoint;
  traceContext?: TraceContext;
};

export type SubagentCheckpoint = {
  messages: AgentMessage[];
  contractState?: ContractState;
  searchStats?: { attempted: number; succeeded: number; failed: number; failures: string[] };
  marketTransaction?: {
    sampledProductId?: string;
    activeProductId?: string;
    candidateKinds: Array<[string, "criterion" | "attribute"]>;
    directPatchCandidateIds: string[];
    semanticCandidateIds: string[];
    outstandingCandidateIds: string[];
    batchResolved: boolean;
    complete: boolean;
  };
  lastCompletedActivity: string;
};

export type ChildEvent =
  | { type: "status"; state: "starting" | "running"; message: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; name: string; args: unknown }
  | { type: "tool_end"; name: string; result: unknown; isError: boolean }
  | { type: "checkpoint"; checkpoint: SubagentCheckpoint }
  | { type: "python_request"; id: string; operation: "tool"; tool: string; callId: string; arguments: unknown; context?: PythonToolRuntimeContext }
  | { type: "python_request"; id: string; operation: "validator"; validator: string; value: unknown; context?: Record<string, unknown> }
  | { type: "python_cancel"; id: string }
  | { type: "result"; text: string; value?: unknown; messages: AgentMessage[] }
  | { type: "error"; message: string };

export type ParentEvent =
  | { type: "python_response"; id: string; ok: true; result: unknown }
  | { type: "python_response"; id: string; ok: false; error: string }
  | { type: "abort"; reason: "user" | "timeout" };
