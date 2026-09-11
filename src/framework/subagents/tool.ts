import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ResolvedAgentProfile, RuntimeLlmOverride } from "../types.ts";
import { SubagentManager } from "./manager.ts";

type Overrides = Record<string, RuntimeLlmOverride>;

export function createDelegationTool(
  profiles: ResolvedAgentProfile[],
  manager: SubagentManager,
  getOverrides: () => Overrides,
  getSessionId: () => string = () => "unknown-session",
): AgentTool<any> {
  const subagents = profiles.filter((profile) => profile.role === "subagent");
  const publicSubagents = subagents.filter((profile) => profile.id !== "market_agent");
  return {
    name: "delegate_agent",
    label: "Delegate agent",
    description: `Run or recover one serial foreground subagent task. Actions: delegate(agent, task), resume(taskId), cancel(taskId). Available agents: ${publicSubagents.map(({ id, description }) => `${id}: ${description}`).join("; ")}. Subagents cannot delegate further.`,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("delegate"), Type.Literal("resume"), Type.Literal("cancel")]),
      agent: Type.Optional(Type.String({ description: "Subagent id for delegate." })),
      task: Type.Optional(Type.String({ description: "A complete, self-contained task for delegate." })),
      taskId: Type.Optional(Type.String({ description: "Existing logical subagent task id for resume or cancel." })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate) {
      if (params.action === "resume" || params.action === "cancel") {
        if (!params.taskId?.trim()) throw new Error(`delegate_agent action '${params.action}' requires 'taskId'.`);
        if (params.agent !== undefined || params.task !== undefined) {
          throw new Error(`delegate_agent action '${params.action}' accepts only 'taskId'.`);
        }
        const result = params.action === "resume"
          ? await manager.resume(params.taskId, signal, onUpdate)
          : await manager.cancel(params.taskId, onUpdate);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: { action: params.action, taskId: params.taskId, status: result.status },
        };
      }
      if (params.taskId !== undefined) throw new Error("delegate_agent action 'delegate' does not accept 'taskId'.");
      if (!params.agent) throw new Error("delegate_agent action 'delegate' requires 'agent'.");
      if (params.agent === "market_agent") {
        throw new Error("market_agent is an internal stage and cannot be delegated directly.");
      }
      const profile = publicSubagents.find((item) => item.id === params.agent);
      if (!profile) throw new Error(`Unknown subagent: ${params.agent}`);
      if (!params.task?.trim()) throw new Error("delegate_agent action 'delegate' requires a non-empty task.");
      const overrides = getOverrides();
      const result = await manager.delegate({
        profile,
        task: params.task,
        signal,
        onUpdate,
        override: overrides[profile.id],
        overrides,
        sessionId: getSessionId(),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: { action: "delegate", agent: profile.id, taskId: result.taskId, runId: result.taskId, status: result.status },
      };
    },
  };
}
