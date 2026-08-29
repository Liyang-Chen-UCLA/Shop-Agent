import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { validateJsonSchema } from "./schema.ts";
import type { PythonConfig, PythonToolDefinition } from "./types.ts";

const BASE_ENV = ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT", "COMSPEC"];
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

async function findManifests(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return findManifests(fullPath);
      return entry.isFile() && entry.name === "tool.json" ? [fullPath] : [];
    }));
    return nested.flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function parseManifest(manifestPath: string, value: unknown): PythonToolDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${manifestPath} must contain a JSON object.`);
  }
  const manifest = value as Record<string, unknown>;
  for (const field of ["name", "description", "entry"] as const) {
    if (typeof manifest[field] !== "string" || !manifest[field]) {
      throw new Error(`${manifestPath}: '${field}' must be a non-empty string.`);
    }
  }
  for (const field of ["inputSchema", "outputSchema"] as const) {
    if (!manifest[field] || typeof manifest[field] !== "object" || Array.isArray(manifest[field])) {
      throw new Error(`${manifestPath}: '${field}' must be a JSON Schema object.`);
    }
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

function buildEnvironment(config: PythonConfig, definition: PythonToolDefinition): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of new Set([...BASE_ENV, ...config.envAllowlist, ...(definition.env ?? [])])) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.killed || child.exitCode !== null) return;
  child.kill();
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.unref();
  }
}

async function executePythonTool(
  definition: PythonToolDefinition,
  config: PythonConfig,
  callId: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeoutMs = definition.timeoutMs ?? config.timeoutMs;
  return new Promise((resolve, reject) => {
    const child = spawn(config.executable, [definition.entry], {
      cwd: definition.directory,
      env: buildEnvironment(config, definition),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      terminate(child);
      finish(() => reject(new Error(`Python tool '${definition.name}' was aborted.`)));
    };
    const timer = setTimeout(() => {
      terminate(child);
      finish(() => reject(new Error(`Python tool '${definition.name}' timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
        terminate(child);
        finish(() => reject(new Error(`Python tool '${definition.name}' exceeded the stdout limit.`)));
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(`Python tool '${definition.name}' exited with code ${code}: ${stderr.trim()}`));
          return;
        }
        let envelope: unknown;
        try {
          envelope = JSON.parse(stdout.trim());
        } catch {
          reject(new Error(`Python tool '${definition.name}' returned invalid JSON.`));
          return;
        }
        if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
          reject(new Error(`Python tool '${definition.name}' returned an invalid response envelope.`));
          return;
        }
        const response = envelope as { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } };
        if (!response.ok) {
          reject(new Error(`${response.error?.code ?? "PYTHON_TOOL_ERROR"}: ${response.error?.message ?? "Unknown error"}`));
          return;
        }
        const validation = validateJsonSchema(definition.outputSchema, response.result);
        if (!validation.valid) {
          reject(new Error(`Python tool '${definition.name}' output validation failed: ${validation.error}`));
          return;
        }
        resolve(response.result);
      });
    });
    child.stdin.end(`${JSON.stringify({ callId, tool: definition.name, arguments: args })}\n`);
  });
}

export function createPythonAgentTools(
  definitions: Map<string, PythonToolDefinition>,
  allowlist: string[],
  config: PythonConfig,
): AgentTool<any>[] {
  return allowlist
    .filter((name) => name !== "delegate_agent")
    .map((name) => {
      const definition = definitions.get(name);
      if (!definition) throw new Error(`Agent allowlist references unknown Python tool: ${name}`);
      return {
        name: definition.name,
        label: definition.name,
        description: definition.description,
        parameters: Type.Unsafe(definition.inputSchema) as TSchema,
        executionMode: "sequential",
        async execute(toolCallId, params, signal) {
          const result = await executePythonTool(definition, config, toolCallId, params, signal);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: { tool: definition.name },
          };
        },
      } satisfies AgentTool<any>;
    });
}
