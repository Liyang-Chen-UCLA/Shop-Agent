import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";

export type JsonSchema = Record<string, unknown>;

/** Opt-in schema configuration for the framework-owned contract state tools. */
export type ContractStateConfig = {
  itemSchemas: {
    criterion: JsonSchema;
    attribute: JsonSchema;
  };
  /** Optional framework-owned fields present in persisted state items. */
  runtimeItemSchema?: JsonSchema;
  /** Defaults applied to state items before runtime metadata is validated. */
  runtimeItemDefaults?: Record<string, unknown>;
  /** Fields that a trusted runtime callback may update without changing definition. */
  runtimeMutableFields?: string[];
};

export type RuntimeLlmSettings = {
  model: string;
  thinking: ThinkingLevel;
};

/** Partial LLM settings used for agent, tool, and evaluator overrides. */
export type RuntimeLlmOverride = Partial<RuntimeLlmSettings>;

export type RuntimeLlmTools = {
  webSearch: RuntimeLlmOverride;
  productExtractor: RuntimeLlmOverride;
};

export type RuntimeLlmEval = {
  semanticMatcher: RuntimeLlmOverride;
  definitionJudge: RuntimeLlmOverride;
};

export type RuntimeLlmConfig = {
  default: RuntimeLlmSettings;
  agents: Record<string, RuntimeLlmOverride>;
  tools: RuntimeLlmTools;
  eval: RuntimeLlmEval;
};

export type RuntimeTimeoutConfig = {
  subagentDefaultMs: number;
  agents: Record<string, number>;
};

export type RuntimeMarketConfig = {
  maxDistinctProducts: number;
};

export type RuntimeConfig = {
  llm: RuntimeLlmConfig;
  timeout: RuntimeTimeoutConfig;
  market: RuntimeMarketConfig;
};

export type RuntimeConfigInput = {
  llm?: {
    default?: RuntimeLlmOverride;
    agents?: Record<string, RuntimeLlmOverride>;
    tools?: Partial<RuntimeLlmTools>;
    eval?: Partial<RuntimeLlmEval>;
  };
  timeout?: {
    subagentDefaultMs?: number;
    agents?: Record<string, number>;
  };
  market?: Partial<RuntimeMarketConfig>;
};

export type PromptSource = string | { file: string };

export type AgentProfile = {
  id: string;
  role: "orchestrator" | "subagent";
  description: string;
  systemPrompt: PromptSource;
  /** Optional repo-local skill instructions explicitly loaded into this profile. */
  skill?: PromptSource;
  /** Search policy for the profile's native web_search tool. */
  webSearchPolicy?: "criteria" | "market";
  tools?: string[];
  /** Enables framework-owned get_state, patch_state, patch_state_batch, and finalize_state tools. */
  contractState?: ContractStateConfig;
  outputSchema?: JsonSchema;
  /** Trusted postprocessor configuration; never exposed as an LLM-visible tool. */
  outputValidator?: OutputValidatorConfig;
  maxRetries?: number;
  timeoutMs?: number;
};

export type OutputValidatorConfig = {
  /** Stable framework registry id for a trusted validator implementation. */
  id: string;
};

export type PythonConfig = {
  timeoutMs: number;
  envAllowlist: string[];
};

export type ShopAgentPaths = {
  dataset: string;
  runtimeData: string;
};

export type ShopAgentConfig = {
  provider: "opencode-go";
  orchestrator: string;
  agents: AgentProfile[];
  toolDirectories: string[];
  python: PythonConfig;
  paths: ShopAgentPaths;
  runtime: RuntimeConfig;
};

export type ShopAgentConfigInput = Partial<Omit<ShopAgentConfig, "python" | "paths" | "runtime">> & {
  paths?: Partial<ShopAgentPaths>;
  python?: Partial<PythonConfig>;
  runtime?: RuntimeConfigInput;
};

export type ResolvedAgentProfile = Omit<AgentProfile, "systemPrompt"> & {
  systemPrompt: string;
  skillPrompt?: string;
};

export type ResolvedConfig = Omit<ShopAgentConfig, "agents"> & {
  agents: ResolvedAgentProfile[];
  cwd: string;
  configPath?: string;
  /** Trusted absolute runtime data directory derived from paths.runtimeData. */
  dataDirectory: string;
  /** Trusted absolute dataset path derived from paths.dataset. */
  datasetPath: string;
};

export type PythonToolDefinition = {
  name: string;
  description: string;
  entry: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  timeoutMs?: number;
  env?: string[];
  directory: string;
  manifestPath: string;
};

export type PythonToolRuntimeContext = {
  sessionId: string;
  dataDirectory: string;
  /** Trusted child-run identity used by one-shot, per-run shopping cursors. */
  runId?: string;
  /** Trusted configured dataset path; never model-authored. */
  datasetPath?: string;
  /** Trusted configured sample cap; never model-authored. */
  maxDistinctProducts?: number;
  /** Optional trusted agent label for narrow diagnostics. */
  agentName?: string;
};

export type NativeToolRuntimeContext = {
  sessionId: string;
  agentName: string;
  projectRoot: string;
};

export type SessionMetadata = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  thinking: ThinkingLevel;
  agentOverrides: Record<string, RuntimeLlmOverride>;
};

export type LoadedSession = {
  metadata: SessionMetadata;
  messages: AgentMessage[];
};

export type RunSummary = {
  id: string;
  agent: string;
  task: string;
  state: "running" | "completed" | "interrupted" | "cancelled";
  startedAt: string;
  endedAt?: string;
  error?: string;
  reason?: string;
  execution: number;
  executionId?: string;
  stageAgent?: string;
  resumable?: boolean;
};

export type RunEvent = {
  timestamp: string;
  execution: number;
  type: "status" | "reasoning" | "writing" | "tool_start" | "tool_end" | "checkpoint" | "resume" | "cancel" | "result" | "error";
  state?: RunSummary["state"];
  message?: string;
  tool?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
};

export type RunDetail = RunSummary & {
  model: string;
  thinking: ThinkingLevel;
  events: RunEvent[];
  output?: string;
  value?: unknown;
};

export type SubagentUpdateDetails = {
  kind: "subagent";
  taskId: string;
  /** Compatibility alias for existing TUI run cards. */
  runId: string;
  agent: string;
  task: string;
  event: RunEvent;
};

export type ProductTask = {
  task_id: string;
  product: string;
  preference: Record<string, string | number | boolean | Array<string | number | boolean>>;
  route: { node_id: string; node_name: string; node_path: string };
};

export type TaskState = {
  schema_version: 1;
  active_task_id: string | null;
  tasks: ProductTask[];
};

export type ShopAgentEvent =
  | { type: "agent_event"; event: unknown }
  | { type: "session_changed"; session: SessionMetadata }
  | { type: "notice"; message: string }
  | { type: "error"; message: string };
