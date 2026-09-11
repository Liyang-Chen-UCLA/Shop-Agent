import type { AgentProfile } from "../src/framework/index.ts";
import { attributeSchema, criterionSchema, marketRuntimeItemSchema, taxonomyNodeSchema } from "./schemas.ts";

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
    description: "Maintains a category-level evaluation contract from confirmed taxonomy facts and publishes it through framework state.",
    systemPrompt: { file: "./shop/prompts/research-agent.md" },
    tools: ["web_search", "get_state", "patch_state", "patch_state_batch", "finalize_state", "report_developer_issue"],
    contractState: {
      itemSchemas: {
        criterion: criterionSchema,
        attribute: attributeSchema,
      },
    },
    timeoutMs: 600_000,
    maxRetries: 0,
  },
  {
    id: "market_agent",
    role: "subagent",
    description: "Maintains the canonical market contract while processing sampled Taobao OCR contexts one product at a time.",
    systemPrompt: { file: "./shop/prompts/market-agent.md" },
    skill: { file: "./shop/skills/market-alignment/SKILL.md" },
    tools: ["shopping_env", "extract_product", "semantic_match_batch", "get_state", "patch_state", "patch_state_batch", "finalize_state", "web_search", "report_developer_issue"],
    webSearchPolicy: "market",
    contractState: {
      itemSchemas: {
        criterion: criterionSchema,
        attribute: attributeSchema,
      },
      runtimeItemSchema: marketRuntimeItemSchema,
      runtimeItemDefaults: { observed_product_ids: [] },
      runtimeMutableFields: ["aliases", "observed_product_ids"],
    },
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
