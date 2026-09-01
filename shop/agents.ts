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

const commonItemProperties = {
  id: { type: "string" },
  name: { type: "string" },
  description: { type: "string" },
  aliases: { type: "array", items: { type: "string" } },
};
const numericDirectionSchema = {
  anyOf: [
    { type: "object", properties: { type: { const: "larger_better" } }, required: ["type"], additionalProperties: false },
    { type: "object", properties: { type: { const: "smaller_better" } }, required: ["type"], additionalProperties: false },
    { type: "object", properties: { type: { const: "target_range" }, unit: { type: "string" } }, required: ["type", "unit"], additionalProperties: false },
  ],
};
const booleanDirectionSchema = {
  anyOf: [
    { type: "object", properties: { type: { const: "true_better" } }, required: ["type"], additionalProperties: false },
    { type: "object", properties: { type: { const: "false_better" } }, required: ["type"], additionalProperties: false },
  ],
};
const categoricalDirectionSchema = {
  anyOf: [
    { type: "object", properties: { type: { const: "total_order" }, order: { type: "array", items: { type: "string" } } }, required: ["type", "order"], additionalProperties: false },
    { type: "object", properties: { type: { const: "partial_order" }, better_than: { type: "array", items: { type: "array", items: { type: "string" } } } }, required: ["type", "better_than"], additionalProperties: false },
    { type: "object", properties: { type: { const: "preferred_set" }, values: { type: "array", items: { type: "string" } } }, required: ["type", "values"], additionalProperties: false },
  ],
};
const numericCriterionSchema = {
  type: "object",
  properties: { ...commonItemProperties, type: { const: "numeric" }, units: { type: "array", items: { type: "string" } }, formula: { type: ["string", "null"] }, direction: numericDirectionSchema },
  required: ["id", "name", "description", "aliases", "type", "units", "direction"],
  additionalProperties: false,
};
const booleanCriterionSchema = {
  type: "object",
  properties: { ...commonItemProperties, type: { const: "boolean" }, direction: booleanDirectionSchema },
  required: ["id", "name", "description", "aliases", "type", "direction"],
  additionalProperties: false,
};
const categoricalCriterionSchema = {
  type: "object",
  properties: { ...commonItemProperties, type: { const: "categorical" }, values: { type: "array", items: { type: "string" } }, value_domain: { type: "string", enum: ["open", "closed"] }, direction: categoricalDirectionSchema },
  required: ["id", "name", "description", "aliases", "type", "values", "value_domain", "direction"],
  additionalProperties: false,
};
const numericAttributeSchema = {
  type: "object",
  properties: { ...commonItemProperties, type: { const: "numeric" }, units: { type: "array", items: { type: "string" } }, formula: { type: ["string", "null"] } },
  required: ["id", "name", "description", "aliases", "type", "units"],
  additionalProperties: false,
};
const booleanAttributeSchema = {
  type: "object",
  properties: { ...commonItemProperties, type: { const: "boolean" } },
  required: ["id", "name", "description", "aliases", "type"],
  additionalProperties: false,
};
const categoricalAttributeSchema = {
  type: "object",
  properties: { ...commonItemProperties, type: { const: "categorical" }, values: { type: "array", items: { type: "string" } }, value_domain: { type: "string", enum: ["open", "closed"] } },
  required: ["id", "name", "description", "aliases", "type", "values", "value_domain"],
  additionalProperties: false,
};

export const criteriaOutputSchema = {
  type: "object",
  properties: {
    node: {
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" }, path: { type: "array", items: { type: "string" } } },
      required: ["id", "name", "path"],
      additionalProperties: false,
    },
    criteria: { type: "array", items: { anyOf: [numericCriterionSchema, booleanCriterionSchema, categoricalCriterionSchema] } },
    attributes: { type: "array", items: { anyOf: [numericAttributeSchema, booleanAttributeSchema, categoricalAttributeSchema] } },
  },
  required: ["node", "criteria", "attributes"],
  additionalProperties: false,
};

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
    id: "criteria_agent",
    role: "subagent",
    description: "Constructs transient category-level evaluation standards and distinguishing attributes from confirmed taxonomy facts.",
    systemPrompt: { file: "./shop/prompts/criteria-agent.md" },
    tools: ["web_search", "report_developer_issue"],
    outputSchema: criteriaOutputSchema,
    outputValidator: { id: "criteria_v1", maxOutputRepairs: 1 },
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
