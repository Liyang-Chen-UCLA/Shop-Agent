import { createHash } from "node:crypto";

export const TRACE_PAYLOAD_LIMIT = 20_000;

const SECRET_KEY = /(?:api.?key|authorization|auth|bearer|cookie|credential|password|private.?key|secret|token)/i;
const REASONING_KEY = /(?:reasoning|thinking|thoughtSignature|chainOfThought)/i;
const SECRET_TEXT = /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]+|(?:sk|pk)-(?:lf-)?[A-Za-z0-9_-]{8,}|[A-Z][A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)\s*[=:]\s*[^\s,;]+)/gi;

type Truncated = {
  truncated: true;
  originalLength: number;
  sha256: string;
  preview: string;
};

function truncate(text: string, limit: number): string | Truncated {
  if (text.length <= limit) return text;
  return {
    truncated: true,
    originalLength: text.length,
    sha256: createHash("sha256").update(text).digest("hex"),
    preview: text.slice(0, limit),
  };
}

function redactText(text: string): string {
  return text.replace(SECRET_TEXT, "[REDACTED]");
}

function clean(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") return truncate(redactText(value), TRACE_PAYLOAD_LIMIT);
  if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (depth > 20) return "[MAX_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item) => clean(item, seen, depth + 1));
    seen.delete(value);
    return result;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "thinking") {
    seen.delete(value);
    return { type: "thinking", redacted: true };
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (REASONING_KEY.test(key)) {
      result[key] = "[REDACTED_REASONING]";
    } else if (SECRET_KEY.test(key)) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = clean(item, seen, depth + 1);
    }
  }
  seen.delete(value);
  return result;
}

/** Redact secrets/reasoning and replace oversized payloads with a bounded preview. */
export function sanitizeTracePayload(value: unknown, limit = TRACE_PAYLOAD_LIMIT): unknown {
  const cleaned = clean(value, new WeakSet(), 0);
  if (typeof cleaned === "string") return truncate(cleaned, limit);
  let serialized: string;
  try {
    serialized = JSON.stringify(cleaned);
  } catch {
    return "[UNSERIALIZABLE]";
  }
  if (serialized.length <= limit) return cleaned;
  return {
    truncated: true,
    originalLength: serialized.length,
    sha256: createHash("sha256").update(serialized).digest("hex"),
    preview: serialized.slice(0, limit),
  } satisfies Truncated;
}

export function errorMessage(error: unknown): string {
  const value = sanitizeTracePayload(error instanceof Error ? error.message : String(error));
  return typeof value === "string" ? value : JSON.stringify(value);
}
