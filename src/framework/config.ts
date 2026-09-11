import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AgentProfile,
  PromptSource,
  ResolvedAgentProfile,
  ResolvedConfig,
  ShopAgentConfig,
  ShopAgentConfigInput,
  RuntimeConfig,
  RuntimeLlmConfig,
  RuntimeLlmOverride,
  RuntimeLlmSettings,
} from "./types.ts";
import { listTrustedOutputValidators } from "./output-validator.ts";
import { validateContractStateConfig } from "./contract-state.ts";

const FALLBACK_ORCHESTRATOR_PROMPT = "Route each request to an available focused subagent when useful, then synthesize its result.";
const FALLBACK_DELEGATE_PROMPT = "Complete the one bounded task provided by the orchestrator and return a self-contained result.";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  llm: {
    default: {
      model: "hy3",
      thinking: "off",
    },
    agents: {},
    tools: {
      webSearch: {
        model: "mimo-v2.5",
        thinking: "off",
      },
      productExtractor: {
        model: "hy3",
        thinking: "off",
      },
    },
    eval: {
      semanticMatcher: {},
      definitionJudge: {},
    },
  },
  timeout: {
    subagentDefaultMs: 120_000,
    agents: {},
  },
  market: {
    maxDistinctProducts: 5,
  },
};

export const DEFAULT_CONFIG: ShopAgentConfig = {
  provider: "opencode-go",
  orchestrator: "orchestrator",
  agents: [
    {
      id: "orchestrator",
      role: "orchestrator",
      description: "Routes work to focused subagents and synthesizes their results.",
      systemPrompt: FALLBACK_ORCHESTRATOR_PROMPT,
      tools: ["delegate_agent"],
    },
    {
      id: "delegate",
      role: "subagent",
      description: "A general, tool-free subagent for a single bounded task.",
      systemPrompt: FALLBACK_DELEGATE_PROMPT,
      tools: [],
      maxRetries: 0,
    },
  ],
  toolDirectories: ["shop/tools"],
  python: {
    timeoutMs: 60_000,
    envAllowlist: [],
  },
  paths: {
    dataset: "data/taobao-product-context/data/products.parquet",
    runtimeData: ".shop-agent",
  },
  runtime: DEFAULT_RUNTIME_CONFIG,
};

export function defineConfig(config: ShopAgentConfigInput): ShopAgentConfigInput {
  return config;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  return value;
}

/** Merge config objects recursively while keeping arrays as replacement values. */
function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return cloneValue(base);
  if (!isRecord(base) || !isRecord(override)) return cloneValue(override);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) result[key] = cloneValue(value);
  for (const [key, value] of Object.entries(override)) result[key] = deepMerge(base[key], value);
  return result;
}

function mergeConfig(input: ShopAgentConfigInput): ShopAgentConfig {
  const pythonInput = input.python ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...input,
    paths: {
      ...DEFAULT_CONFIG.paths,
      ...input.paths,
    },
    agents: input.agents ?? DEFAULT_CONFIG.agents,
    toolDirectories: input.toolDirectories ?? DEFAULT_CONFIG.toolDirectories,
    python: {
      timeoutMs: pythonInput.timeoutMs ?? DEFAULT_CONFIG.python.timeoutMs,
      envAllowlist: pythonInput.envAllowlist ?? DEFAULT_CONFIG.python.envAllowlist,
    },
    runtime: deepMerge(DEFAULT_RUNTIME_CONFIG, input.runtime) as RuntimeConfig,
  };
}

async function resolvePromptSource(cwd: string, source: PromptSource): Promise<string> {
  if (typeof source === "string") return source;
  const promptPath = path.resolve(cwd, source.file);
  return readFile(promptPath, "utf8");
}

async function resolveProfile(cwd: string, profile: AgentProfile): Promise<ResolvedAgentProfile> {
  let systemPrompt: string;
  systemPrompt = await resolvePromptSource(cwd, profile.systemPrompt);
  const skillPrompt = profile.skill ? await resolvePromptSource(cwd, profile.skill) : undefined;
  return { ...profile, systemPrompt, ...(skillPrompt === undefined ? {} : { skillPrompt }) };
}

function validatePositiveInteger(value: unknown, label: string): void {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
}

function validateLlmOverride(value: unknown, label: string, requireComplete = false): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  if (requireComplete && (typeof value.model !== "string" || !value.model.trim())) {
    throw new Error(`${label}.model must be a non-empty string.`);
  }
  if (value.model !== undefined && (typeof value.model !== "string" || !value.model.trim())) {
    throw new Error(`${label}.model must be a non-empty string.`);
  }
  if (value.thinking !== undefined && !THINKING_LEVELS.includes(value.thinking as typeof THINKING_LEVELS[number])) {
    throw new Error(`${label}.thinking must be one of ${THINKING_LEVELS.join(", ")}.`);
  }
  if (requireComplete && value.thinking === undefined) {
    throw new Error(`${label}.thinking must be configured.`);
  }
}

function validateLlmMap(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  for (const [key, setting] of Object.entries(value)) validateLlmOverride(setting, `${label}.${key}`);
}

function validateRuntime(config: ShopAgentConfig): void {
  const runtime = config.runtime as unknown;
  if (!isRecord(runtime)) throw new Error("runtime must be an object.");

  const llm = runtime.llm;
  if (!isRecord(llm)) throw new Error("runtime.llm must be an object.");
  validateLlmOverride(llm.default, "runtime.llm.default", true);
  validateLlmMap(llm.agents, "runtime.llm.agents");

  const tools = llm.tools;
  if (!isRecord(tools)) throw new Error("runtime.llm.tools must be an object.");
  validateLlmOverride(tools.webSearch, "runtime.llm.tools.webSearch");
  validateLlmOverride(tools.productExtractor, "runtime.llm.tools.productExtractor");

  const evaluation = llm.eval;
  if (!isRecord(evaluation)) throw new Error("runtime.llm.eval must be an object.");
  validateLlmOverride(evaluation.semanticMatcher, "runtime.llm.eval.semanticMatcher");
  validateLlmOverride(evaluation.definitionJudge, "runtime.llm.eval.definitionJudge");

  const timeout = runtime.timeout;
  if (!isRecord(timeout)) throw new Error("runtime.timeout must be an object.");
  validatePositiveInteger(timeout.subagentDefaultMs, "runtime.timeout.subagentDefaultMs");
  if (!isRecord(timeout.agents)) throw new Error("runtime.timeout.agents must be an object.");
  for (const [agentId, value] of Object.entries(timeout.agents)) {
    if (!agentId.trim()) throw new Error("runtime.timeout.agents cannot contain an empty agent id.");
    validatePositiveInteger(value, `runtime.timeout.agents.${agentId}`);
  }

  const market = runtime.market;
  if (!isRecord(market)) throw new Error("runtime.market must be an object.");
  validatePositiveInteger(market.maxDistinctProducts, "runtime.market.maxDistinctProducts");
}

function validateConfig(config: ShopAgentConfig): void {
  validateRuntime(config);
  if (!config.paths || typeof config.paths !== "object") {
    throw new Error("paths must be an object.");
  }
  if (typeof config.paths.dataset !== "string" || !config.paths.dataset.trim()) {
    throw new Error("paths.dataset must be a non-empty string.");
  }
  if (typeof config.paths.runtimeData !== "string" || !config.paths.runtimeData.trim()) {
    throw new Error("paths.runtimeData must be a non-empty string.");
  }
  if (!Array.isArray(config.agents)) throw new Error("agents must be an array.");
  const ids = new Set<string>();
  for (const profile of config.agents) {
    if (!profile || typeof profile !== "object" || typeof profile.id !== "string" || !profile.id.trim()) {
      throw new Error("Agent profile id cannot be empty.");
    }
    if (ids.has(profile.id)) throw new Error(`Duplicate agent profile: ${profile.id}`);
    ids.add(profile.id);
    if (profile.timeoutMs !== undefined) validatePositiveInteger(profile.timeoutMs, `Agent '${profile.id}' timeoutMs`);
    if (profile.contractState) {
      try {
        validateContractStateConfig(profile.contractState);
      } catch (error) {
        throw new Error(`Agent '${profile.id}' has invalid contractState config: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (profile.outputValidator) {
      if (!listTrustedOutputValidators().includes(profile.outputValidator.id)) {
        throw new Error(`Agent '${profile.id}' references unknown trusted output validator '${profile.outputValidator.id}'.`);
      }
      if (!profile.outputSchema) throw new Error(`Agent '${profile.id}' configures an output validator without outputSchema.`);
    }
  }
  const orchestrator = config.agents.find((profile) => profile.id === config.orchestrator);
  if (!orchestrator) throw new Error(`Orchestrator profile not found: ${config.orchestrator}`);
  if (orchestrator.role !== "orchestrator") throw new Error("Configured orchestrator must have role 'orchestrator'.");
}

export async function loadConfig(cwd: string, explicitPath?: string, override?: ShopAgentConfigInput): Promise<ResolvedConfig> {
  const configPath = explicitPath
    ? path.resolve(cwd, explicitPath)
    : path.join(cwd, "shop-agent.config.ts");
  let input: ShopAgentConfigInput = {};
  let loadedPath: string | undefined;

  if (await exists(configPath)) {
    const moduleUrl = `${pathToFileURL(configPath).href}?v=${Date.now()}`;
    const imported = await import(moduleUrl) as { default?: ShopAgentConfigInput };
    if (!imported.default || typeof imported.default !== "object") {
      throw new Error(`${configPath} must export a default configuration object.`);
    }
    input = imported.default;
    loadedPath = configPath;
  } else if (explicitPath) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const mergedInput: ShopAgentConfigInput = override
    ? {
      ...input,
      ...override,
      paths: { ...input.paths, ...override.paths },
      python: { ...input.python, ...override.python },
      runtime: deepMerge(input.runtime, override.runtime) as ShopAgentConfigInput["runtime"],
    }
    : input;
  const config = mergeConfig(mergedInput);
  validateConfig(config);
  const resolvedConfig = {
    ...config,
    dataDirectory: path.resolve(cwd, config.paths.runtimeData),
    datasetPath: path.resolve(cwd, config.paths.dataset),
    cwd,
    configPath: loadedPath,
  };
  const agents = await Promise.all(config.agents.map((profile) => resolveProfile(cwd, profile)));
  return { ...resolvedConfig, agents };
}

type RuntimeSource = RuntimeConfig | { runtime: RuntimeConfig };
type RuntimeLlmSource = RuntimeLlmConfig | RuntimeConfig | { runtime: RuntimeConfig };

function runtimeFrom(source: RuntimeSource): RuntimeConfig {
  return "runtime" in source ? source.runtime : source;
}

function llmFrom(source: RuntimeLlmSource): RuntimeLlmConfig {
  if ("runtime" in source) return source.runtime.llm;
  if ("llm" in source) return source.llm;
  return source;
}

/** Resolve Agent LLM settings with session > agent > global precedence. */
export function resolveAgentLlm(
  source: RuntimeSource,
  agentId: string,
  sessionOverride?: RuntimeLlmOverride,
): RuntimeLlmSettings {
  const runtime = runtimeFrom(source);
  const agent = runtime.llm.agents[agentId] ?? {};
  return {
    model: sessionOverride?.model ?? agent.model ?? runtime.llm.default.model,
    thinking: sessionOverride?.thinking ?? agent.thinking ?? runtime.llm.default.thinking,
  };
}

/** Resolve a model-backed tool with tool > global precedence. */
export function resolveToolLlm(
  source: RuntimeLlmSource,
  tool: keyof RuntimeLlmConfig["tools"],
): RuntimeLlmSettings {
  const llm = llmFrom(source);
  const own = llm.tools[tool] ?? {};
  return {
    model: own.model ?? llm.default.model,
    thinking: own.thinking ?? llm.default.thinking,
  };
}

/** Resolve an evaluator with evaluator > global precedence. */
export function resolveEvalLlm(
  source: RuntimeLlmSource,
  evaluator: keyof RuntimeConfig["llm"]["eval"],
): RuntimeLlmSettings {
  const llm = llmFrom(source);
  const own = llm.eval[evaluator] ?? {};
  return {
    model: own.model ?? llm.default.model,
    thinking: own.thinking ?? llm.default.thinking,
  };
}

/** Resolve subagent timeout with runtime agent > profile > runtime default precedence. */
export function resolveSubagentTimeout(
  source: RuntimeSource,
  profile: Pick<AgentProfile, "id" | "timeoutMs">,
): number {
  const runtime = runtimeFrom(source);
  return runtime.timeout.agents[profile.id] ?? profile.timeoutMs ?? runtime.timeout.subagentDefaultMs;
}
