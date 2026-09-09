import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CriteriaDocument, CriteriaItem, MarketPredictionDocument, MarketPredictionItem } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function parseItems(value: unknown, label: string): CriteriaItem[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`${label}[${index}] must be an object.`);
    const aliases = candidate.aliases;
    if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== "string")) {
      throw new Error(`${label}[${index}].aliases must be an array of strings.`);
    }
    return {
      ...candidate,
      id: requireText(candidate.id, `${label}[${index}].id`),
      name: requireText(candidate.name, `${label}[${index}].name`),
      aliases,
      type: requireText(candidate.type, `${label}[${index}].type`),
    } as CriteriaItem;
  });
}

export function parseCriteriaDocument(value: unknown, label: string): CriteriaDocument {
  if (!isRecord(value)) throw new Error(`${label} must contain a JSON object.`);
  if (!isRecord(value.node)) throw new Error(`${label}.node must be an object.`);
  if (!Array.isArray(value.node.path) || value.node.path.some((part) => typeof part !== "string")) {
    throw new Error(`${label}.node.path must be an array of strings.`);
  }
  return {
    ...value,
    node: {
      id: requireText(value.node.id, `${label}.node.id`),
      name: requireText(value.node.name, `${label}.node.name`),
      path: value.node.path,
    },
    criteria: parseItems(value.criteria, `${label}.criteria`),
    attributes: parseItems(value.attributes, `${label}.attributes`),
  } as CriteriaDocument;
}

function parseObservedProductIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label}.observed_product_ids must be an array of non-empty strings.`);
  }
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label}.observed_product_ids must contain unique product IDs.`);
  }
  return [...ids];
}

function normalizeMarketPredictionItem(item: CriteriaItem, label: string): MarketPredictionItem {
  if (!Object.hasOwn(item, "observed_product_ids")) {
    throw new Error(`${label}.observed_product_ids is required for a Market prediction item.`);
  }
  return {
    ...item,
    observed_product_ids: parseObservedProductIds(item.observed_product_ids, label),
  };
}

function normalizeMarketPredictionDocument(
  document: CriteriaDocument,
  label: string,
): MarketPredictionDocument {
  return {
    ...document,
    criteria: document.criteria.map((item, index) => normalizeMarketPredictionItem(item, `${label}.criteria[${index}]`)),
    attributes: document.attributes.map((item, index) => normalizeMarketPredictionItem(item, `${label}.attributes[${index}]`)),
  };
}

export function parseMarketPredictionDocument(value: unknown, label: string): MarketPredictionDocument {
  return normalizeMarketPredictionDocument(parseCriteriaDocument(value, label), label);
}

/** Keep only Market items observed in at least one trusted sampled product. */
export function filterObservedMarketItems(
  prediction: CriteriaDocument,
  label = "Prediction market.json",
): MarketPredictionDocument {
  const normalized = normalizeMarketPredictionDocument(prediction, label);
  return {
    ...normalized,
    criteria: normalized.criteria.filter((item) => item.observed_product_ids.length >= 1),
    attributes: normalized.attributes.filter((item) => item.observed_product_ids.length >= 1),
  };
}

async function readDocument(filePath: string, label: string): Promise<CriteriaDocument> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`${label} not found: ${filePath}`);
    throw error;
  }
  try {
    return parseCriteriaDocument(JSON.parse(raw), label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON: ${filePath}`);
    throw error;
  }
}

export async function loadEvalCase(projectRoot: string, caseId: string): Promise<CriteriaDocument> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(caseId)) {
    throw new Error("--case must be a single safe case id (letters, numbers, '.', '_' or '-').");
  }
  return readDocument(path.join(projectRoot, "eval", "cases", caseId, "gold.json"), `Eval case '${caseId}' gold`);
}

export async function loadPredictionArtifacts(
  runtimeData: string,
  nodeId: string,
): Promise<{ prediction: MarketPredictionDocument; base?: CriteriaDocument }> {
  const directory = path.join(runtimeData, "market-criteria", nodeId);
  const prediction = parseMarketPredictionDocument(
    await readDocument(path.join(directory, "market.json"), "Prediction market.json"),
    "Prediction market.json",
  );
  let base: CriteriaDocument | undefined;
  try {
    base = await readDocument(path.join(directory, "base.json"), "Attribution base.json");
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Attribution base.json not found:")) throw error;
  }
  return {
    prediction: filterObservedMarketItems(prediction),
    ...(base ? { base } : {}),
  };
}
