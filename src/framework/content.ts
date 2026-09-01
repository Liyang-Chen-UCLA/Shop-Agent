import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const DEVELOPER_DIAGNOSTIC_REDACTED = "[DEVELOPER_DIAGNOSTIC_REDACTED]";

export function messageText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
        return String(part.text);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Preserve assistant/tool-call pairing while removing developer-diagnostic
 * payloads from persisted transcripts. The live Agent state is never mutated.
 */
export function sanitizeDeveloperDiagnosticMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      let changed = false;
      const content = message.content.map((part) => {
        if (part.type !== "toolCall" || part.name !== "report_developer_issue") return part;
        changed = true;
        return { ...part, arguments: { redacted: DEVELOPER_DIAGNOSTIC_REDACTED } };
      });
      return changed ? { ...message, content } : message;
    }
    if (message.role === "toolResult" && message.toolName === "report_developer_issue") {
      return {
        ...message,
        content: [{ type: "text", text: DEVELOPER_DIAGNOSTIC_REDACTED }],
        details: DEVELOPER_DIAGNOSTIC_REDACTED,
      };
    }
    return message;
  });
}

export function isDeveloperDiagnosticMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as { role?: unknown; toolName?: unknown; content?: unknown };
  if (candidate.role === "toolResult" && candidate.toolName === "report_developer_issue") return true;
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return false;
  return candidate.content.some((part) => (
    !!part && typeof part === "object" &&
    (part as { type?: unknown }).type === "toolCall" &&
    (part as { name?: unknown }).name === "report_developer_issue"
  ));
}

/** True for lifecycle/message events that could carry a diagnostic payload. */
export function isDeveloperDiagnosticAgentEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const candidate = event as { type?: unknown; toolName?: unknown; message?: unknown; assistantMessageEvent?: unknown };
  if (typeof candidate.type === "string" && candidate.type.startsWith("tool_execution_") && candidate.toolName === "report_developer_issue") return true;
  if (isDeveloperDiagnosticMessage(candidate.message)) return true;
  const update = candidate.assistantMessageEvent;
  if (!update || typeof update !== "object") return false;
  return isDeveloperDiagnosticMessage((update as { partial?: unknown }).partial);
}

/** Clone lifecycle events before exposing them outside the live Agent state. */
export function sanitizeDeveloperDiagnosticAgentEvent(event: unknown): unknown {
  if (!event || typeof event !== "object") return event;
  const candidate = event as { type?: unknown; messages?: unknown; message?: unknown };
  if (candidate.type === "agent_end" && Array.isArray(candidate.messages)) {
    return { ...candidate, messages: sanitizeDeveloperDiagnosticMessages(candidate.messages as AgentMessage[]) };
  }
  return event;
}
