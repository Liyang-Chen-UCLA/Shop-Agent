import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SECRET_PATTERN = /(api[_-]?key|authorization|token|secret)(\s*[=:]\s*)([^\s,;]+)/gi;

function redact(value: string): string {
  let result = value.replace(SECRET_PATTERN, "$1$2[REDACTED]");
  const key = process.env.OPENCODE_API_KEY;
  if (key) result = result.split(key).join("[REDACTED]");
  return result;
}

export class Logger {
  readonly filePath: string;

  constructor(dataDirectory: string) {
    this.filePath = path.join(dataDirectory, "logs", "shop-agent.log");
  }

  async write(level: "info" | "error", message: string, error?: unknown): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error ?? "");
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message: redact(message),
      detail: detail ? redact(detail) : undefined,
    });
    await appendFile(this.filePath, `${entry}\n`, "utf8");
  }
}
