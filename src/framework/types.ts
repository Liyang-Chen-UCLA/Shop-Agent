import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";

export type JsonSchema = Record<string, unknown>;

export type ModelChoice = {
  provider: "opencode-go";
  id: string;
};

export type PromptSource = string | { file: string };

export type AgentProfile = {
  id: string;
  role: "orchestrator" | "subagent";
  description: string;
  systemPrompt: PromptSource;
  model?: ModelChoice;
  thinking?: ThinkingLevel;
  tools?: string[];
  outputSchema?: JsonSchema;
  /** Trusted postprocessor configuration; never exposed as an LLM-visible tool. */
  outputValidator?: OutputValidatorConfig;
  maxRetries?: number;
  timeoutMs?: number;
};

export type OutputValidatorConfig = {
  /** Stable framework registry id for a trusted validator implementation. */
  id: string;
  /** Number of same-context JSON repair steers allowed after the initial output. */
  maxOutputRepairs?: number;
};

export type PythonConfig = {
  executable: string;
  timeoutMs: number;
  envAllowlist: string[];
};

export type ShopAgentConfig = {
  provider: "opencode-go";
  defaultModel: string;
  defaultThinking: ThinkingLevel;
  orchestrator: string;
  agents: AgentProfile[];
  toolDirectories: string[];
  python: PythonConfig;
  dataDirectory: string;
};

export type ShopAgentConfigInput = Partial<Omit<ShopAgentConfig, "python">> & {
  python?: Partial<PythonConfig>;
};

export type ResolvedAgentProfile = Omit<AgentProfile, "systemPrompt"> & {
  systemPrompt: string;
};

export type ResolvedConfig = Omit<ShopAgentConfig, "agents"> & {
  agents: ResolvedAgentProfile[];
  cwd: string;
  configPath?: string;
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
  agentOverrides: Record<string, { model?: string; thinking?: ThinkingLevel }>;
};

export type LoadedSession = {
  metadata: SessionMetadata;
  messages: AgentMessage[];
};

export type RunSummary = {
  id: string;
  agent: string;
  task: string;
  state: "starting" | "running" | "completed" | "failed" | "aborted";
  startedAt: string;
  endedAt?: string;
  error?: string;
};

export type RunEvent = {
  timestamp: string;
  attempt: number;
  type: "status" | "reasoning" | "writing" | "tool_start" | "tool_end" | "retry" | "result" | "error";
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
