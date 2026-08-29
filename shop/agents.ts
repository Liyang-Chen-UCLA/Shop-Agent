import type { AgentProfile } from "../src/framework/index.ts";

export const agents: AgentProfile[] = [
  {
    id: "orchestrator",
    role: "orchestrator",
    description: "Routes work to focused subagents and synthesizes their results.",
    systemPrompt: { file: "./shop/prompts/orchestrator.md" },
    tools: ["delegate_agent"],
  },
  {
    id: "delegate",
    role: "subagent",
    description: "A general, tool-free subagent for a single bounded task.",
    systemPrompt: { file: "./shop/prompts/delegate.md" },
    tools: [],
    maxRetries: 0,
  },
];
