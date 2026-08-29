import type { JsonSchema } from "./types.ts";

export type SchemaValidation = { valid: true } | { valid: false; error: string };

function typeMatches(expected: string, value: unknown): boolean {
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === expected;
}

export function validateJsonSchema(schema: JsonSchema, value: unknown, path = "$"): SchemaValidation {
  const expected = schema.type;
  if (typeof expected === "string" && !typeMatches(expected, value)) {
    return { valid: false, error: `${path} must be ${expected}` };
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    return { valid: false, error: `${path} is not an allowed value` };
  }

  if (expected === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !(key in record)) {
        return { valid: false, error: `${path}.${key} is required` };
      }
    }
    const properties = schema.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
      for (const [key, childSchema] of Object.entries(properties)) {
        if (key in record && childSchema && typeof childSchema === "object" && !Array.isArray(childSchema)) {
          const result = validateJsonSchema(childSchema as JsonSchema, record[key], `${path}.${key}`);
          if (!result.valid) return result;
        }
      }
    }
    if (schema.additionalProperties === false && properties && typeof properties === "object") {
      const allowed = new Set(Object.keys(properties));
      const extra = Object.keys(record).find((key) => !allowed.has(key));
      if (extra) return { valid: false, error: `${path}.${extra} is not allowed` };
    }
  }

  if (expected === "array" && Array.isArray(value) && schema.items && typeof schema.items === "object") {
    for (let index = 0; index < value.length; index += 1) {
      const result = validateJsonSchema(schema.items as JsonSchema, value[index], `${path}[${index}]`);
      if (!result.valid) return result;
    }
  }

  return { valid: true };
}
