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

const productExtractionValueProperties = {
  raw_value: { type: "string", minLength: 1 },
  normalized_value: { type: ["string", "number", "boolean", "null"] },
  unit: { type: ["string", "null"] },
  qualifier: { type: ["string", "null"] },
  evidence: { type: "string", minLength: 1 },
  ocr_page_id: { type: ["string", "null"] },
};

const observedProductValueSchema = {
  type: "object",
  properties: {
    ...productExtractionValueProperties,
    normalized_value: { type: ["string", "number", "boolean"] },
  },
  required: ["raw_value", "normalized_value", "unit", "qualifier", "evidence", "ocr_page_id"],
  additionalProperties: false,
};

const unparsedProductValueSchema = {
  type: "object",
  properties: {
    ...productExtractionValueProperties,
    normalized_value: { const: null },
  },
  required: ["raw_value", "normalized_value", "unit", "qualifier", "evidence", "ocr_page_id"],
  additionalProperties: false,
};

function productExtractionEntrySchema(item: Record<string, unknown>) {
  return {
    oneOf: [
      {
        type: "object",
        properties: {
          item,
          status: { const: "observed" },
          values: { type: "array", minItems: 1, items: observedProductValueSchema },
        },
        required: ["item", "status", "values"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          item,
          status: { const: "unparsed" },
          values: { type: "array", minItems: 1, items: unparsedProductValueSchema },
        },
        required: ["item", "status", "values"],
        additionalProperties: false,
      },
    ],
  };
}

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
    criteria: { type: "array", items: productExtractionEntrySchema(criterionSchema) },
    attributes: { type: "array", items: productExtractionEntrySchema(attributeSchema) },
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
const marketMetadataProperties = {
  observed_product_count: { type: "integer" },
  market_alignment: { type: "string", enum: ["matched", "corrected_from_conflict", "added_from_market"] },
  web_evidence: {
    type: "array",
    items: { anyOf: [{ type: "string" }, { type: "object" }] },
  },
};
const marketNumericCriterionSchema = {
  ...numericCriterionSchema,
  properties: { ...numericCriterionSchema.properties, ...marketMetadataProperties },
  required: [...numericCriterionSchema.required, "observed_product_count", "market_alignment", "web_evidence"],
};
const marketBooleanCriterionSchema = {
  ...booleanCriterionSchema,
  properties: { ...booleanCriterionSchema.properties, ...marketMetadataProperties },
  required: [...booleanCriterionSchema.required, "observed_product_count", "market_alignment", "web_evidence"],
};
const marketCategoricalCriterionSchema = {
  ...categoricalCriterionSchema,
  properties: { ...categoricalCriterionSchema.properties, ...marketMetadataProperties },
  required: [...categoricalCriterionSchema.required, "observed_product_count", "market_alignment", "web_evidence"],
};
const marketNumericAttributeSchema = {
  ...numericAttributeSchema,
  properties: { ...numericAttributeSchema.properties, ...marketMetadataProperties },
  required: [...numericAttributeSchema.required, "observed_product_count", "market_alignment", "web_evidence"],
};
const marketBooleanAttributeSchema = {
  ...booleanAttributeSchema,
  properties: { ...booleanAttributeSchema.properties, ...marketMetadataProperties },
  required: [...booleanAttributeSchema.required, "observed_product_count", "market_alignment", "web_evidence"],
};
const marketCategoricalAttributeSchema = {
  ...categoricalAttributeSchema,
  properties: { ...categoricalAttributeSchema.properties, ...marketMetadataProperties },
  required: [...categoricalAttributeSchema.required, "observed_product_count", "market_alignment", "web_evidence"],
};
const marketValueSchema = {
  type: "object",
  properties: {
    raw_value: { type: "string" },
    normalized_value: { type: ["string", "number", "boolean", "null"] },
    unit: { type: ["string", "null"] },
    qualifier: { type: ["string", "null"] },
    evidence: { type: ["string", "null"] },
    ocr_page_id: { type: ["string", "null"] },
  },
  required: ["raw_value", "normalized_value"],
  additionalProperties: false,
};
const marketExtractionSchema = {
  type: "object",
  properties: {
    item_id: { type: "string" },
    status: { type: "string", enum: ["observed", "unparsed", "not_mentioned"] },
    values: { type: "array", items: marketValueSchema },
  },
  required: ["item_id", "status", "values"],
  additionalProperties: false,
};
const marketProductSchema = {
  type: "object",
  properties: {
    dataset_category: { type: "string" },
    item_id: { type: "string" },
    criteria: { type: "array", items: marketExtractionSchema },
    attributes: { type: "array", items: marketExtractionSchema },
  },
  required: ["dataset_category", "item_id", "criteria", "attributes"],
  additionalProperties: false,
};

export const marketOutputSchema = {
  type: "object",
  properties: {
    node: marketNodeSchema,
    dataset_category: { type: "string" },
    traversed_product_count: { type: "integer" },
    product_ids: { type: "array", items: { type: "string" } },
    criteria: { type: "array", items: { anyOf: [marketNumericCriterionSchema, marketBooleanCriterionSchema, marketCategoricalCriterionSchema] } },
    attributes: { type: "array", items: { anyOf: [marketNumericAttributeSchema, marketBooleanAttributeSchema, marketCategoricalAttributeSchema] } },
    products: { type: "array", items: marketProductSchema },
  },
  required: ["node", "dataset_category", "traversed_product_count", "product_ids", "criteria", "attributes", "products"],
  additionalProperties: false,
};
