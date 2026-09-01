import type { ResolvedAgentProfile } from "./types.ts";

const FRAMEWORK_INVARIANTS = `Framework rules:
- Use only the tools provided in this run.
- Never fabricate a tool call, tool result, subagent result, or external fact.
- Treat tool errors as errors rather than successful results.
- Follow the active agent profile and stay within its responsibility.`;

export function composeSystemPrompt(profile: ResolvedAgentProfile): string {
  const outputRule = profile.outputSchema
    ? "\n\nReturn only valid JSON matching the configured output schema. Do not wrap it in Markdown fences."
    : "";
  const skill = profile.skillPrompt?.trim()
    ? `\n\nLoaded repo skill:\n${profile.skillPrompt.trim()}`
    : "";
  return `${FRAMEWORK_INVARIANTS}\n\n${profile.systemPrompt.trim()}${skill}${outputRule}`;
}
