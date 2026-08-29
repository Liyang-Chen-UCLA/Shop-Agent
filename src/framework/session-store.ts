import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { LoadedSession, SessionMetadata } from "./types.ts";
import { messageText } from "./content.ts";

type StoredLine = { type: "message"; message: AgentMessage };

export class SessionStore {
  readonly directory: string;

  constructor(dataDirectory: string) {
    this.directory = path.join(dataDirectory, "sessions");
  }

  private metadataPath(id: string): string {
    return path.join(this.directory, `${id}.meta.json`);
  }

  private messagesPath(id: string): string {
    return path.join(this.directory, `${id}.jsonl`);
  }

  async create(model: string, thinking: ThinkingLevel): Promise<LoadedSession> {
    await mkdir(this.directory, { recursive: true });
    const now = new Date().toISOString();
    const metadata: SessionMetadata = {
      id: randomUUID(),
      title: "New session",
      createdAt: now,
      updatedAt: now,
      model,
      thinking,
      agentOverrides: {},
    };
    await writeFile(this.metadataPath(metadata.id), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await writeFile(this.messagesPath(metadata.id), "", "utf8");
    return { metadata, messages: [] };
  }

  async saveMetadata(metadata: SessionMetadata): Promise<void> {
    metadata.updatedAt = new Date().toISOString();
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.metadataPath(metadata.id), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }

  async appendMessages(session: LoadedSession, messages: AgentMessage[]): Promise<void> {
    if (!messages.length) return;
    await mkdir(this.directory, { recursive: true });
    const lines = messages.map((message) => JSON.stringify({ type: "message", message } satisfies StoredLine)).join("\n");
    await appendFile(this.messagesPath(session.metadata.id), `${lines}\n`, "utf8");
    if (session.metadata.title === "New session") {
      const firstUser = messages.find((message) => message.role === "user");
      const text = firstUser ? messageText(firstUser).replace(/\s+/g, " ").trim() : "";
      if (text) session.metadata.title = text.length > 56 ? `${text.slice(0, 53)}...` : text;
    }
    await this.saveMetadata(session.metadata);
  }

  async load(idOrPrefix: string): Promise<LoadedSession> {
    const sessions = await this.list();
    const matches = sessions.filter((item) => item.id === idOrPrefix || item.id.startsWith(idOrPrefix));
    if (matches.length === 0) throw new Error(`Session not found: ${idOrPrefix}`);
    if (matches.length > 1) throw new Error(`Session id is ambiguous: ${idOrPrefix}`);
    const metadata = matches[0];
    const raw = await readFile(this.messagesPath(metadata.id), "utf8");
    const messages: AgentMessage[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as StoredLine;
      if (parsed.type === "message") messages.push(parsed.message);
    }
    return { metadata, messages };
  }

  async list(): Promise<SessionMetadata[]> {
    await mkdir(this.directory, { recursive: true });
    const files = await readdir(this.directory);
    const metadata = await Promise.all(
      files
        .filter((file) => file.endsWith(".meta.json"))
        .map(async (file) => JSON.parse(await readFile(path.join(this.directory, file), "utf8")) as SessionMetadata),
    );
    return metadata.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
