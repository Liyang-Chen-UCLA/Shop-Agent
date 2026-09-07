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
} from "./types.ts";
import { listTrustedOutputValidators } from "./output-validator.ts";

const FALLBACK_ORCHESTRATOR_PROMPT = "Route each request to an available focused subagent when useful, then synthesize its result.";
const FALLBACK_DELEGATE_PROMPT = "Complete the one bounded task provided by the orchestrator and return a self-contained result.";

export const DEFAULT_CONFIG: ShopAgentConfig = {
  provider: "opencode-go",
  defaultModel: "hy3",
  defaultThinking: "off",
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
  maxDistinctProducts: 5,
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

function validateConfig(config: ShopAgentConfig): void {
  if (!config.paths || typeof config.paths !== "object") {
    throw new Error("paths must be an object.");
  }
  if (typeof config.paths.dataset !== "string" || !config.paths.dataset.trim()) {
    throw new Error("paths.dataset must be a non-empty string.");
  }
  if (typeof config.paths.runtimeData !== "string" || !config.paths.runtimeData.trim()) {
    throw new Error("paths.runtimeData must be a non-empty string.");
  }
  if (!Number.isInteger(config.maxDistinctProducts) || config.maxDistinctProducts <= 0) {
    throw new Error("maxDistinctProducts must be a positive integer.");
  }
  const ids = new Set<string>();
  for (const profile of config.agents) {
    if (!profile.id.trim()) throw new Error("Agent profile id cannot be empty.");
    if (ids.has(profile.id)) throw new Error(`Duplicate agent profile: ${profile.id}`);
    ids.add(profile.id);
    if (profile.outputValidator) {
      if (!listTrustedOutputValidators().includes(profile.outputValidator.id)) {
        throw new Error(`Agent '${profile.id}' references unknown trusted output validator '${profile.outputValidator.id}'.`);
      }
      const repairs = profile.outputValidator.maxOutputRepairs ?? 0;
      if (!Number.isInteger(repairs) || repairs < 0 || repairs > 3) {
        throw new Error(`Agent '${profile.id}' output validator maxOutputRepairs must be an integer from 0 to 3.`);
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
