import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ResolvedAgentProfile } from "../types.ts";
import { SubagentManager } from "./manager.ts";

type Overrides = Record<string, { model?: string; thinking?: ThinkingLevel }>;

export function createDelegationTool(
  profiles: ResolvedAgentProfile[],
  manager: SubagentManager,
  getOverrides: () => Overrides,
): AgentTool<any> {
  const subagents = profiles.filter((profile) => profile.role === "subagent");
  return {
    name: "delegate_agent",
    label: "Delegate agent",
    description: "List focused subagents, inspect one profile, or run one foreground subagent with a fresh context. Subagents cannot delegate further.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("get"), Type.Literal("run")]),
      agent: Type.Optional(Type.String({ description: "Subagent id for get or run." })),
      task: Type.Optional(Type.String({ description: "A complete, self-contained task for run." })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate) {
      if (params.action === "list") {
        const result = subagents.map(({ id, description }) => ({ id, description }));
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { action: "list" } };
      }
      if (!params.agent) throw new Error(`delegate_agent action '${params.action}' requires 'agent'.`);
      const profile = subagents.find((item) => item.id === params.agent);
      if (!profile) throw new Error(`Unknown subagent: ${params.agent}`);
      if (params.action === "get") {
        const result = { id: profile.id, description: profile.description, tools: profile.tools ?? [], outputSchema: profile.outputSchema };
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { action: "get", agent: profile.id } };
      }
      if (!params.task?.trim()) throw new Error("delegate_agent action 'run' requires a non-empty task.");
      const result = await manager.run({
        profile,
        task: params.task,
        signal,
        onUpdate,
        override: getOverrides()[profile.id],
      });
      return {
        content: [{ type: "text", text: result.value === undefined ? result.text : JSON.stringify(result.value) }],
        details: { action: "run", agent: profile.id, runId: result.runId },
      };
    },
  };
}
