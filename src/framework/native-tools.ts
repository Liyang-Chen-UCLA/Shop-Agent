import { appendFile, mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { messageText } from "./content.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { NativeToolRuntimeContext } from "./types.ts";

export const WEB_SEARCH_TOOL = "web_search";
export const DEVELOPER_ISSUE_TOOL = "report_developer_issue";
export const NATIVE_TOOL_NAMES = [WEB_SEARCH_TOOL, DEVELOPER_ISSUE_TOOL] as const;
export const WEB_SEARCH_MODEL = "muse-spark-1.2-contributor";
export const WEB_SEARCH_THINKING = "low" as const;
export const SEARCH_TRUNCATION_MARKER = "[搜索结果因长度限制已截断]";
export const SEARCH_RESULT_MAX_CHARS = 8_000;
export const MIN_CRITERIA_SEARCH_QUERIES = 4;
export const MAX_CRITERIA_SEARCH_QUERIES = 5;

export type NativeToolDefinition = {
  name: (typeof NATIVE_TOOL_NAMES)[number];
  description: string;
};

const NATIVE_TOOL_DEFINITIONS: readonly NativeToolDefinition[] = [
  { name: WEB_SEARCH_TOOL, description: "Research one query through an isolated fixed-model context." },
  { name: DEVELOPER_ISSUE_TOOL, description: "Append a bounded developer diagnostic with trusted framework metadata." },
];

export type SearchStats = {
  attempted: number;
  succeeded: number;
  failed: number;
  failures: string[];
};

export function criteriaSearchSatisfied(stats: Pick<SearchStats, "attempted" | "succeeded">): boolean {
  return stats.attempted >= MIN_CRITERIA_SEARCH_QUERIES && stats.succeeded >= 1;
}

export type NativeToolFactoryOptions = {
  runtime: ModelRuntime;
  projectRoot: string;
  getRuntimeContext: () => NativeToolRuntimeContext;
  webSearchPrompt?: string;
};

export type NativeAgentToolSet = {
  tools: AgentTool<any>[];
  searchStats: SearchStats;
};

export type DeveloperIssueInput = {
  category: "semantic_conflict" | "ambiguous_instruction" | "insufficient_information" | "taxonomy_mismatch" | "schema_gap" | "other";
  summary: string;
  context: string;
  affected_entities: string[];
  evidence: string[];
  action_taken: "omitted" | "conservative_choice";
};

const ISSUE_CATEGORIES = [
  "semantic_conflict",
  "ambiguous_instruction",
  "insufficient_information",
  "taxonomy_mismatch",
  "schema_gap",
  "other",
] as const;
const ISSUE_ACTIONS = ["omitted", "conservative_choice"] as const;
const MAX_SUMMARY_CHARS = 500;
const MAX_CONTEXT_CHARS = 1_500;
const MAX_ENTITY_CHARS = 200;
const MAX_EVIDENCE_CHARS = 500;
const MAX_LIST_ITEMS = 20;

function bounded(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim() : String(value ?? "");
  return text.slice(0, max);
}

function safeText(value: unknown, max: number): string {
  return bounded(value, max)
    .replace(/(OPENCODE_API_KEY|OPENAI_API_KEY|api[_ -]?key|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, "[REDACTED_SECRET]");
}

function safeList(value: unknown, maxItemChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_LIST_ITEMS).map((item) => safeText(item, maxItemChars)).filter(Boolean);
}

export function truncateSearchResult(value: string, maxChars = SEARCH_RESULT_MAX_CHARS): string {
  if (value.length <= maxChars) return value;
  const marker = SEARCH_TRUNCATION_MARKER;
  let limit = Math.max(0, maxChars - marker.length);
  if (value.charCodeAt(limit - 1) >= 0xd800 && value.charCodeAt(limit - 1) <= 0xdbff) limit -= 1;
  return `${value.slice(0, limit)}${marker}`;
}

function searchPrompt(projectRoot: string, override?: string): string {
  if (override) return override;
  try {
    return readFileSync(path.join(projectRoot, "shop", "prompts", "web-search.md"), "utf8");
  } catch {
    return "针对用户给出的单条检索词，提供简洁、谨慎的中文研究摘要。不要伪造网址、引用或声称实际浏览；只返回研究文字。";
  }
}

async function runIsolatedSearch(
  runtime: ModelRuntime,
  systemPrompt: string,
  query: string,
): Promise<string> {
  const model = runtime.getModel(WEB_SEARCH_MODEL);
  runtime.ensureThinking(model, WEB_SEARCH_THINKING);
  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt.trim(),
      model,
      thinkingLevel: WEB_SEARCH_THINKING,
      tools: [],
      messages: [],
    },
    streamFn: runtime.models.streamSimple.bind(runtime.models),
    sessionId: `web-search-${randomUUID()}`,
    toolExecution: "sequential",
  });
  await agent.prompt(`请只研究这一条检索词，并返回简洁的研究摘要：\n${query}`);
  const finalMessage = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
  const text = finalMessage ? messageText(finalMessage).trim() : "";
  if (!text) throw new Error(agent.state.errorMessage || "web search returned no research text");
  return truncateSearchResult(text);
}

export async function writeDeveloperIssue(
  projectRoot: string,
  context: NativeToolRuntimeContext,
  input: DeveloperIssueInput,
): Promise<void> {
  const directory = path.join(projectRoot, ".shop-agent", "developer-feedback");
  const filePath = path.join(directory, "issues.jsonl");
  await mkdir(directory, { recursive: true });
  const record = {
    timestamp: new Date().toISOString(),
    session_id: bounded(context.sessionId, 200),
    agent: bounded(context.agentName, 120),
    category: ISSUE_CATEGORIES.includes(input.category) ? input.category : "other",
    summary: safeText(input.summary, MAX_SUMMARY_CHARS),
    context: safeText(input.context, MAX_CONTEXT_CHARS),
    affected_entities: safeList(input.affected_entities, MAX_ENTITY_CHARS),
    evidence: safeList(input.evidence, MAX_EVIDENCE_CHARS),
    action_taken: ISSUE_ACTIONS.includes(input.action_taken) ? input.action_taken : "omitted",
  };
  await appendFile(filePath, `${JSON.stringify(record, null, 0)}\n`, "utf8");
}

function createSearchTool(
  options: NativeToolFactoryOptions,
  searchStats: SearchStats,
): AgentTool<any> {
  const prompt = searchPrompt(options.projectRoot, options.webSearchPrompt);
  return {
    name: WEB_SEARCH_TOOL,
    label: WEB_SEARCH_TOOL,
    description: "Research one search query and return concise research text. The query is the only input.",
    parameters: Type.Object({ query: Type.String({ description: "One focused search query." }) }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (!query) throw new Error("web_search requires a non-empty query.");
      if (searchStats.attempted >= MAX_CRITERIA_SEARCH_QUERIES) {
        throw new Error(`web_search allows at most ${MAX_CRITERIA_SEARCH_QUERIES} queries in one criteria run.`);
      }
      searchStats.attempted += 1;
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const result = await runIsolatedSearch(options.runtime, prompt, query);
          searchStats.succeeded += 1;
          return { content: [{ type: "text", text: result }], details: { tool: WEB_SEARCH_TOOL } };
        } catch (error) {
          lastError = error;
        }
      }
      searchStats.failed += 1;
      if (searchStats.failures.length < 10) searchStats.failures.push(safeText(lastError instanceof Error ? lastError.message : lastError, 300));
      throw new Error(`web_search failed after one retry: ${safeText(lastError instanceof Error ? lastError.message : lastError, 300)}`);
    },
  } satisfies AgentTool<any>;
}

function createDeveloperIssueTool(options: NativeToolFactoryOptions): AgentTool<any> {
  const categories = ISSUE_CATEGORIES.map((item) => Type.Literal(item));
  const actions = ISSUE_ACTIONS.map((item) => Type.Literal(item));
  return {
    name: DEVELOPER_ISSUE_TOOL,
    label: DEVELOPER_ISSUE_TOOL,
    description: "Record a bounded developer diagnostic. It does not control business flow or wait for a reply.",
    parameters: Type.Object({
      category: Type.Union(categories),
      summary: Type.String(),
      context: Type.String(),
      affected_entities: Type.Array(Type.String()),
      evidence: Type.Array(Type.String()),
      action_taken: Type.Union(actions),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      await writeDeveloperIssue(options.projectRoot, options.getRuntimeContext(), params as DeveloperIssueInput);
      return { content: [{ type: "text", text: "developer issue recorded" }], details: { tool: DEVELOPER_ISSUE_TOOL } };
    },
  } satisfies AgentTool<any>;
}

export function isNativeToolName(name: string): boolean {
  return (NATIVE_TOOL_NAMES as readonly string[]).includes(name);
}

/** Return the static native registry without instantiating model-backed tools. */
export function discoverNativeTools(): Map<string, NativeToolDefinition> {
  return new Map(NATIVE_TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));
}

export function createNativeAgentToolSet(
  allowlist: readonly string[],
  options: NativeToolFactoryOptions,
): NativeAgentToolSet {
  const searchStats: SearchStats = { attempted: 0, succeeded: 0, failed: 0, failures: [] };
  const tools: AgentTool<any>[] = [];
  for (const name of allowlist) {
    if (name === WEB_SEARCH_TOOL) tools.push(createSearchTool(options, searchStats));
    else if (name === DEVELOPER_ISSUE_TOOL) tools.push(createDeveloperIssueTool(options));
  }
  return { tools, searchStats };
}

export function createNativeAgentTools(
  allowlist: readonly string[],
  options: NativeToolFactoryOptions,
): AgentTool<any>[] {
  return createNativeAgentToolSet(allowlist, options).tools;
}

export async function loadWebSearchPrompt(projectRoot: string): Promise<string> {
  return readFile(path.join(projectRoot, "shop", "prompts", "web-search.md"), "utf8");
}
