import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeSemanticLabel } from "./semantic-matcher.ts";

export type SemanticMatchCacheEntry = {
  terms: string[];
  canonical_item_id: string;
};

export type SemanticMatchCacheDocument = {
  entries: SemanticMatchCacheEntry[];
};

export type SemanticMatchCacheMode = "readOnly" | "readWrite";

export type SemanticCacheItem = {
  id: string;
  name?: string;
  aliases?: readonly string[];
};

export type SemanticMatchCacheOptions = {
  runtimeData: string;
  nodeId: string;
  mode?: SemanticMatchCacheMode;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function parseCacheDocument(value: unknown): SemanticMatchCacheDocument {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error("Semantic match cache must contain an entries array.");
  }
  return {
    entries: value.entries.map((entry, index) => {
      if (!isRecord(entry) || !Array.isArray(entry.terms)) {
        throw new Error(`Semantic match cache entries[${index}] must contain a terms array.`);
      }
      const terms = entry.terms.map((term, termIndex) => requireText(
        term,
        `Semantic match cache entries[${index}].terms[${termIndex}]`,
      ));
      return {
        terms,
        canonical_item_id: requireText(
          entry.canonical_item_id,
          `Semantic match cache entries[${index}].canonical_item_id`,
        ),
      };
    }),
  };
}

function uniqueTerms(terms: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const term of terms) {
    if (typeof term !== "string" || !term.trim()) continue;
    const normalized = normalizeSemanticLabel(term);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(term);
  }
  return result;
}

function itemTerms(item: SemanticCacheItem): string[] {
  return uniqueTerms([
    item.id,
    ...(item.name ? [item.name] : []),
    ...(item.aliases ?? []),
  ]);
}

function cacheFile(runtimeData: string, nodeId: string): string {
  if (!runtimeData.trim()) throw new Error("Semantic match cache runtimeData must be non-empty.");
  if (!nodeId.trim() || nodeId === "." || nodeId === ".." || nodeId.includes("/") || nodeId.includes("\\")) {
    throw new Error("Semantic match cache nodeId must be a safe single path segment.");
  }
  return path.join(runtimeData, "market-criteria", nodeId, "semantic-match.json");
}

/**
 * Taxonomy-scoped positive semantic identity mappings.
 *
 * The cache deliberately has no mutation history. A read-only instance is
 * used by Eval, while a read-write instance is reserved for an accepting
 * Market caller.
 */
export class TaxonomySemanticMatchCache {
  readonly filePath: string;
  private readonly mode: SemanticMatchCacheMode;

  constructor(options: SemanticMatchCacheOptions) {
    this.filePath = cacheFile(options.runtimeData, options.nodeId);
    this.mode = options.mode ?? "readOnly";
  }

  async read(): Promise<SemanticMatchCacheDocument> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
      throw error;
    }
    try {
      return parseCacheDocument(JSON.parse(raw));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Semantic match cache is not valid JSON: ${this.filePath}`);
      }
      throw error;
    }
  }

  /** Return a current canonical id for a positive cached candidate match. */
  async lookup(
    candidate: SemanticCacheItem | readonly string[],
    canonicalItems: readonly SemanticCacheItem[],
  ): Promise<string | undefined> {
    const candidateTerms = Array.isArray(candidate) ? uniqueTerms(candidate) : itemTerms(candidate);
    const normalizedCandidateTerms = new Set(candidateTerms.map(normalizeSemanticLabel).filter(Boolean));
    if (!normalizedCandidateTerms.size) return undefined;

    const currentIds = new Set(canonicalItems.map((item) => item.id));
    const cache = await this.read();
    const matches = cache.entries.filter((entry) => {
      if (!currentIds.has(entry.canonical_item_id)) return false;
      return entry.terms.some((term) => normalizedCandidateTerms.has(normalizeSemanticLabel(term)));
    });
    const targetIds = [...new Set(matches.map((entry) => entry.canonical_item_id))];
    return targetIds.length === 1 ? targetIds[0] : undefined;
  }

  /**
   * Persist one positive accepted mapping. Read-only instances never create or
   * modify a cache file and return false to make that mode observable to tests.
   */
  async writeAccepted(
    candidate: SemanticCacheItem | readonly string[],
    canonicalItem: SemanticCacheItem | string,
  ): Promise<boolean> {
    if (this.mode === "readOnly") return false;

    const terms = Array.isArray(candidate) ? uniqueTerms(candidate) : itemTerms(candidate);
    const canonicalItemId = typeof canonicalItem === "string" ? canonicalItem : canonicalItem.id;
    if (!terms.length) throw new Error("Accepted semantic match must contain at least one candidate term.");
    requireText(canonicalItemId, "Accepted semantic match canonical_item_id");

    const current = await this.read();
    const entries = current.entries.map((entry) => ({ ...entry, terms: [...entry.terms] }));
    const existing = entries.find((entry) => entry.canonical_item_id === canonicalItemId);
    if (existing) {
      existing.terms = uniqueTerms([...existing.terms, ...terms]);
    } else {
      entries.push({ terms, canonical_item_id: canonicalItemId });
    }
    const document: SemanticMatchCacheDocument = { entries };
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = path.join(directory, `.semantic-match-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return true;
  }
}

export { TaxonomySemanticMatchCache as SemanticMatchCache };
