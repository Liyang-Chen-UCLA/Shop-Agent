export const taxonomyNodeSchema = {
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

export const numericCriterionSchema = {
  type: "object",
  properties: { ...commonItemProperties, type: { const: "numeric" }, units: { type: "array", items: { type: "string" } }, formula: { type: ["string", "null"] }, direction: numericDirectionSchema },
  required: ["id", "name", "description", "aliases", "type", "units", "direction"],
  additionalProperties: false,
};
export const booleanCriterionSchema = {
  type: "object",
  properties: { ...commonItemProperties, type: { const: "boolean" }, direction: booleanDirectionSchema },
  required: ["id", "name", "description", "aliases", "type", "direction"],
  additionalProperties: false,
};
export const categoricalCriterionSchema = {
  type: "object",
  properties: { ...commonItemProperties, type: { const: "categorical" }, values: { type: "array", items: { type: "string" } }, value_domain: { type: "string", enum: ["open", "closed"] }, direction: categoricalDirectionSchema },
  required: ["id", "name", "description", "aliases", "type", "values", "value_domain", "direction"],
  additionalProperties: false,
};
export const numericAttributeSchema = {
  type: "object",
  properties: { ...commonItemProperties, type: { const: "numeric" }, units: { type: "array", items: { type: "string" } }, formula: { type: ["string", "null"] } },
  required: ["id", "name", "description", "aliases", "type", "units"],
  additionalProperties: false,
};
export const booleanAttributeSchema = {
  type: "object",
  properties: { ...commonItemProperties, type: { const: "boolean" } },
  required: ["id", "name", "description", "aliases", "type"],
  additionalProperties: false,
};
export const categoricalAttributeSchema = {
  type: "object",
  properties: { ...commonItemProperties, type: { const: "categorical" }, values: { type: "array", items: { type: "string" } }, value_domain: { type: "string", enum: ["open", "closed"] } },
  required: ["id", "name", "description", "aliases", "type", "values", "value_domain"],
  additionalProperties: false,
};

export const criterionSchema = {
  anyOf: [numericCriterionSchema, booleanCriterionSchema, categoricalCriterionSchema],
};
export const attributeSchema = {
  anyOf: [numericAttributeSchema, booleanAttributeSchema, categoricalAttributeSchema],
};

export const extractProductInputSchema = {
  type: "object",
  properties: {
    item_id: { type: "string", minLength: 1 },
    dataset_category: { type: "string", minLength: 1 },
    ocr_text: { type: "string", minLength: 1 },
  },
  required: ["item_id", "dataset_category", "ocr_text"],
  additionalProperties: false,
};

export const productExtractionOutputSchema = {
  type: "object",
  properties: {
    criteria: { type: "array", items: criterionSchema },
    attributes: { type: "array", items: attributeSchema },
  },
  required: ["criteria", "attributes"],
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
    criteria: { type: "array", items: criterionSchema },
    attributes: { type: "array", items: attributeSchema },
  },
  required: ["node", "criteria", "attributes"],
  additionalProperties: false,
};

const marketNodeSchema = {
  type: "object",
  properties: { id: { type: "string" }, name: { type: "string" }, path: { type: "array", items: { type: "string" } } },
  required: ["id", "name", "path"],
  additionalProperties: false,
};

/** Framework-owned Market metadata. LLM patch inputs deliberately use the
 * base item schemas and never accept this field. */
export const marketRuntimeItemSchema = {
  type: "object",
  properties: {
    observed_product_ids: { type: "array", items: { type: "string" } },
  },
  required: ["observed_product_ids"],
  additionalProperties: false,
};

function marketItemSchema(itemSchema: Record<string, unknown>) {
  return {
    ...itemSchema,
    properties: { ...(itemSchema.properties as Record<string, unknown>), ...marketRuntimeItemSchema.properties },
    required: [...(itemSchema.required as string[]), "observed_product_ids"],
  };
}

const marketNumericCriterionSchema = marketItemSchema(numericCriterionSchema);
const marketBooleanCriterionSchema = marketItemSchema(booleanCriterionSchema);
const marketCategoricalCriterionSchema = marketItemSchema(categoricalCriterionSchema);
const marketNumericAttributeSchema = marketItemSchema(numericAttributeSchema);
const marketBooleanAttributeSchema = marketItemSchema(booleanAttributeSchema);
const marketCategoricalAttributeSchema = marketItemSchema(categoricalAttributeSchema);

export const marketOutputSchema = {
  type: "object",
  properties: {
    node: marketNodeSchema,
    criteria: { type: "array", items: { anyOf: [marketNumericCriterionSchema, marketBooleanCriterionSchema, marketCategoricalCriterionSchema] } },
    attributes: { type: "array", items: { anyOf: [marketNumericAttributeSchema, marketBooleanAttributeSchema, marketCategoricalAttributeSchema] } },
  },
  required: ["node", "criteria", "attributes"],
  additionalProperties: false,
};
