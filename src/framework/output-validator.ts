import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { PythonConfig, OutputValidatorConfig } from "./types.ts";

const MAX_VALIDATOR_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_VALIDATOR_ERROR_CHARS = 6_000;

export type TrustedValidationResult =
  | { valid: true; value?: unknown }
  | { valid: false; error: string };

const VALIDATOR_ENTRIES: Readonly<Record<string, string>> = {
  criteria_v1: path.join("shop", "criteria_contract.py"),
};

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.killed || child.exitCode !== null) return;
  child.kill();
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.unref();
  }
}

function validationError(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (text || "trusted validator failed").slice(0, MAX_VALIDATOR_ERROR_CHARS);
}

/**
 * Invoke one explicitly registered trusted validator.  The validator receives
 * only the candidate JSON and returns a small `{ok,result|error}` envelope;
 * no model-authored path or executable is accepted here.
 */
export async function validateWithTrustedValidator(
  validator: OutputValidatorConfig,
  value: unknown,
  python: PythonConfig,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<TrustedValidationResult> {
  const entry = VALIDATOR_ENTRIES[validator.id];
  if (!entry) return { valid: false, error: `Unknown trusted output validator '${validator.id}'.` };
  const entryPath = path.resolve(projectRoot, entry);
  return new Promise<TrustedValidationResult>((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(python.executable, ["-X", "utf8", entryPath], {
      cwd: projectRoot,
      env: {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        PATH: process.env.PATH,
        PATHEXT: process.env.PATHEXT,
        COMSPEC: process.env.COMSPEC,
        ...Object.fromEntries((python.envAllowlist ?? []).filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const timeoutMs = Math.min(Math.max(python.timeoutMs, 1_000), 30_000);
    const timer = setTimeout(() => {
      terminate(child);
      finish({ valid: false, error: `Trusted validator '${validator.id}' timed out.` });
    }, timeoutMs);
    const onAbort = () => {
      terminate(child);
      finish({ valid: false, error: `Trusted validator '${validator.id}' was aborted.` });
    };
    const finish = (result: TrustedValidationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_VALIDATOR_STDOUT_BYTES) {
        terminate(child);
        finish({ valid: false, error: "Trusted validator returned too much output." });
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => finish({ valid: false, error: `Trusted validator failed to start: ${error.message}` }));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({ valid: false, error: `Trusted validator exited with code ${code}: ${validationError(stderr.trim())}` });
        return;
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(stdout.trim());
      } catch {
        finish({ valid: false, error: "Trusted validator returned invalid JSON." });
        return;
      }
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
        finish({ valid: false, error: "Trusted validator returned an invalid response envelope." });
        return;
      }
      const response = envelope as { ok?: boolean; result?: unknown; error?: { message?: unknown } };
      if (response.ok === true) finish({ valid: true, value: response.result });
      else finish({ valid: false, error: validationError(response.error?.message ?? "Trusted validator rejected output.") });
    });
    child.stdin.end(JSON.stringify({ value }) + "\n");
  });
}

export function listTrustedOutputValidators(): string[] {
  return Object.keys(VALIDATOR_ENTRIES);
}

