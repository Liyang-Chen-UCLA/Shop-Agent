import type { AgentMessage } from "@earendil-works/pi-agent-core";

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
