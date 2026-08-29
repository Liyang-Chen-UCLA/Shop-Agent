import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AgentProfile,
  ResolvedAgentProfile,
  ResolvedConfig,
  ShopAgentConfig,
  ShopAgentConfigInput,
} from "./types.ts";

const FALLBACK_ORCHESTRATOR_PROMPT = "Route each request to an available focused subagent when useful, then synthesize its result.";
const FALLBACK_DELEGATE_PROMPT = "Complete the one bounded task provided by the orchestrator and return a self-contained result.";

export const DEFAULT_CONFIG: ShopAgentConfig = {
  provider: "opencode-go",
  defaultModel: "muse-spark-1.2-contributor",
  defaultThinking: "medium",
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
    executable: "D:\\App\\miniforge3\\envs\\shop-agent\\python.exe",
    timeoutMs: 60_000,
    envAllowlist: [],
  },
  dataDirectory: ".shop-agent",
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
  return {
    ...DEFAULT_CONFIG,
    ...input,
    agents: input.agents ?? DEFAULT_CONFIG.agents,
    toolDirectories: input.toolDirectories ?? DEFAULT_CONFIG.toolDirectories,
    python: { ...DEFAULT_CONFIG.python, ...input.python },
  };
}

async function resolveProfile(cwd: string, profile: AgentProfile): Promise<ResolvedAgentProfile> {
  let systemPrompt: string;
  if (typeof profile.systemPrompt === "string") {
    systemPrompt = profile.systemPrompt;
  } else {
    const promptPath = path.resolve(cwd, profile.systemPrompt.file);
    systemPrompt = await readFile(promptPath, "utf8");
  }
  return { ...profile, systemPrompt };
}

function validateConfig(config: ShopAgentConfig): void {
  const ids = new Set<string>();
  for (const profile of config.agents) {
    if (!profile.id.trim()) throw new Error("Agent profile id cannot be empty.");
    if (ids.has(profile.id)) throw new Error(`Duplicate agent profile: ${profile.id}`);
    ids.add(profile.id);
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
    ? { ...input, ...override, python: { ...input.python, ...override.python } }
    : input;
  const config = mergeConfig(mergedInput);
  validateConfig(config);
  const agents = await Promise.all(config.agents.map((profile) => resolveProfile(cwd, profile)));
  return { ...config, agents, cwd, configPath: loadedPath };
}
