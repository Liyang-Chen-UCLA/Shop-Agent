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
  if (Array.isArray(schema.anyOf)) {
    const alternatives = schema.anyOf.filter((item): item is JsonSchema => !!item && typeof item === "object" && !Array.isArray(item));
    if (!alternatives.some((item) => validateJsonSchema(item, value, path).valid)) {
      return { valid: false, error: `${path} does not match any allowed schema` };
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const alternatives = schema.oneOf.filter((item): item is JsonSchema => !!item && typeof item === "object" && !Array.isArray(item));
    if (alternatives.filter((item) => validateJsonSchema(item, value, path).valid).length !== 1) {
      return { valid: false, error: `${path} must match exactly one schema` };
    }
  }

  const expected = schema.type;
  if (Array.isArray(expected)) {
    if (!expected.some((item) => typeof item === "string" && typeMatches(item, value))) {
      return { valid: false, error: `${path} must be one of ${expected.join(", ")}` };
    }
  } else if (typeof expected === "string" && !typeMatches(expected, value)) {
    return { valid: false, error: `${path} must be ${expected}` };
  }

  if ("const" in schema && !Object.is(schema.const, value)) {
    return { valid: false, error: `${path} must equal its configured constant` };
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
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return { valid: false, error: `${path} must contain at least ${schema.minItems} items` };
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return { valid: false, error: `${path} must contain at most ${schema.maxItems} items` };
    }
    for (let index = 0; index < value.length; index += 1) {
      const result = validateJsonSchema(schema.items as JsonSchema, value[index], `${path}[${index}]`);
      if (!result.valid) return result;
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return { valid: false, error: `${path} must contain at least ${schema.minLength} characters` };
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return { valid: false, error: `${path} must contain at most ${schema.maxLength} characters` };
    }
  }

  return { valid: true };
}
