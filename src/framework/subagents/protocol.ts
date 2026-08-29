import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { PythonConfig, PythonToolDefinition, ResolvedAgentProfile } from "../types.ts";

export type ChildRequest = {
  runId: string;
  task: string;
  profile: ResolvedAgentProfile;
  model: string;
  thinking: ThinkingLevel;
  python: PythonConfig;
  tools: PythonToolDefinition[];
};

export type ChildEvent =
  | { type: "status"; state: "starting" | "running"; message: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string; isError: boolean }
  | { type: "result"; text: string; value?: unknown; messages: AgentMessage[] }
  | { type: "error"; message: string };
