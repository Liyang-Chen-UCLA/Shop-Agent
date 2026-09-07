import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PythonExecutor } from "./python-executor.ts";
import { validateJsonSchema } from "./schema.ts";
import type { PythonToolDefinition, PythonToolRuntimeContext } from "./types.ts";

async function findManifests(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return findManifests(fullPath);
      return entry.isFile() && entry.name === "tool.json" ? [fullPath] : [];
    }))).flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function parseManifest(manifestPath: string, value: unknown): PythonToolDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${manifestPath} must contain a JSON object.`);
  const manifest = value as Record<string, unknown>;
  for (const field of ["name", "description", "entry"] as const) {
    if (typeof manifest[field] !== "string" || !manifest[field]) throw new Error(`${manifestPath}: '${field}' must be a non-empty string.`);
  }
  for (const field of ["inputSchema", "outputSchema"] as const) {
    if (!manifest[field] || typeof manifest[field] !== "object" || Array.isArray(manifest[field])) throw new Error(`${manifestPath}: '${field}' must be a JSON Schema object.`);
  }
  const directory = path.dirname(manifestPath);
  return {
    name: manifest.name as string,
    description: manifest.description as string,
    entry: path.resolve(directory, manifest.entry as string),
    inputSchema: manifest.inputSchema as Record<string, unknown>,
    outputSchema: manifest.outputSchema as Record<string, unknown>,
    timeoutMs: typeof manifest.timeoutMs === "number" ? manifest.timeoutMs : undefined,
    env: Array.isArray(manifest.env) ? manifest.env.filter((item): item is string => typeof item === "string") : [],
    directory,
    manifestPath,
  };
}

export async function discoverPythonTools(cwd: string, directories: string[]): Promise<Map<string, PythonToolDefinition>> {
  const manifests = (await Promise.all(directories.map((directory) => findManifests(path.resolve(cwd, directory))))).flat();
  const tools = new Map<string, PythonToolDefinition>();
  for (const manifestPath of manifests) {
    const definition = parseManifest(manifestPath, JSON.parse(await readFile(manifestPath, "utf8")));
    if (tools.has(definition.name)) throw new Error(`Duplicate Python tool name: ${definition.name}`);
    await access(definition.entry);
    tools.set(definition.name, definition);
  }
  return tools;
}

export function createPythonAgentTools(
  definitions: Map<string, PythonToolDefinition>,
  allowlist: string[],
  executor: PythonExecutor,
  getRuntimeContext?: () => PythonToolRuntimeContext,
): AgentTool<any>[] {
  return allowlist.filter((name) => name !== "delegate_agent").map((name) => {
    const definition = definitions.get(name);
    if (!definition) throw new Error(`Agent allowlist references unknown Python tool: ${name}`);
    return {
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: Type.Unsafe(definition.inputSchema) as TSchema,
      executionMode: "sequential",
      async execute(toolCallId, params, signal) {
        const result = await executor.executeTool(definition, toolCallId, params, getRuntimeContext?.(), signal);
        const validation = validateJsonSchema(definition.outputSchema, result);
        if (!validation.valid) throw new Error(`Python tool '${definition.name}' output validation failed: ${validation.error}`);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { tool: definition.name } };
      },
    } satisfies AgentTool<any>;
  });
}
