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
  maxRetries?: number;
  timeoutMs?: number;
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
  state: "starting" | "running" | "completed" | "failed" | "aborted";
  startedAt: string;
  endedAt?: string;
  error?: string;
};

export type ShopAgentEvent =
  | { type: "agent_event"; event: unknown }
  | { type: "session_changed"; session: SessionMetadata }
  | { type: "notice"; message: string }
  | { type: "error"; message: string };
