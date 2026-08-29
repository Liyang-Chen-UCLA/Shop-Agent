import type { AgentProfile } from "../src/framework/index.ts";

const taxonomyNodeSchema = {
  type: "object",
  properties: {
    node_id: { type: "string" },
    node_name: { type: "string" },
    node_path: { type: "string" },
  },
  required: ["node_id", "node_name", "node_path"],
  additionalProperties: false,
};

export const agents: AgentProfile[] = [
  {
    id: "orchestrator",
    role: "orchestrator",
    description: "Maintains category-analysis task state, routes products through the taxonomy, and coordinates evaluation guidance.",
    systemPrompt: { file: "./shop/prompts/orchestrator.md" },
    tools: ["delegate_agent", "task_state_get", "task_state_upsert", "task_state_set_active", "task_state_delete"],
  },
  {
    id: "route_agent",
    role: "subagent",
    description: "Maps normalized product names to canonical taxonomy nodes and discloses direct child categories.",
    systemPrompt: { file: "./shop/prompts/route-agent.md" },
    tools: ["taxonomy_search_nodes", "taxonomy_get_nodes", "taxonomy_get_children"],
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
    id: "product_analyst",
    role: "subagent",
    description: "Constructs category-specific evaluation criteria and selection guidance from one canonical task state.",
    systemPrompt: { file: "./shop/prompts/product-analyst.md" },
    tools: [],
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
