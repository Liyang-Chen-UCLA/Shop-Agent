import type { AgentProfile } from "../src/framework/index.ts";
import { criteriaOutputSchema, marketOutputSchema, taxonomyNodeSchema } from "./schemas.ts";

export { criteriaOutputSchema, marketOutputSchema } from "./schemas.ts";

export const agents: AgentProfile[] = [
  {
    id: "orchestrator",
    role: "orchestrator",
    description: "Maintains category-analysis task state, routes products through the taxonomy, and coordinates evaluation guidance.",
    systemPrompt: { file: "./shop/prompts/orchestrator.md" },
    tools: ["delegate_agent", "task_state_get", "task_state_upsert", "task_state_set_active", "task_state_delete", "report_developer_issue"],
  },
  {
    id: "route_agent",
    role: "subagent",
    description: "Maps normalized product names to canonical taxonomy nodes and discloses direct child categories.",
    systemPrompt: { file: "./shop/prompts/route-agent.md" },
    tools: ["taxonomy_search_nodes", "taxonomy_get_nodes", "taxonomy_get_children", "report_developer_issue"],
    outputSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              product: { type: "string" },
              status: { type: "string", enum: ["resolved", "ambiguous"] },
              resolved_nodes: { type: "array", items: taxonomyNodeSchema },
              candidates: { type: "array", items: taxonomyNodeSchema },
              children: { type: "array", items: taxonomyNodeSchema },
            },
            required: ["product", "status", "resolved_nodes", "candidates", "children"],
            additionalProperties: false,
          },
        },
      },
      required: ["results"],
      additionalProperties: false,
    },
    maxRetries: 1,
  },
  {
    id: "research_agent",
    role: "subagent",
    description: "Constructs transient category-level evaluation standards and distinguishing attributes from confirmed taxonomy facts.",
    systemPrompt: { file: "./shop/prompts/research-agent.md" },
    tools: ["web_search", "report_developer_issue"],
    outputSchema: criteriaOutputSchema,
    outputValidator: { id: "criteria_v1" },
    timeoutMs: 600_000,
    maxRetries: 0,
  },
  {
    id: "market_agent",
    role: "subagent",
    description: "Aligns the trusted base contract with selected Taobao OCR contexts and extracts every final criterion and attribute.",
    systemPrompt: { file: "./shop/prompts/market-agent.md" },
    skill: { file: "./shop/skills/market-alignment/SKILL.md" },
    tools: ["load_base", "shopping_env", "web_search", "report_developer_issue"],
    webSearchPolicy: "market",
    outputSchema: marketOutputSchema,
    outputValidator: { id: "market_v1" },
    timeoutMs: 600_000,
    maxRetries: 0,
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
