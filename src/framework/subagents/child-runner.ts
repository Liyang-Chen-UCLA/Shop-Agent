import { Agent } from "@earendil-works/pi-agent-core";
import { createModelRuntime } from "../model-runtime.ts";
import { createPythonAgentTools } from "../python-tools.ts";
import { createNativeAgentToolSet, criteriaSearchSatisfied, DEVELOPER_ISSUE_TOOL, WEB_SEARCH_TOOL, writeDeveloperIssue } from "../native-tools.ts";
import { messageText, sanitizeDeveloperDiagnosticMessages } from "../content.ts";
import { createTerminalOutputTool } from "../terminal-output.ts";
import { createContractStateTools } from "../contract-state.ts";
import { composeSystemPrompt } from "../system-prompt.ts";
import type { ChildEvent, ChildRequest } from "./protocol.ts";
import { createInterface } from "node:readline";
import { ChildPythonProxy } from "./python-proxy.ts";
import { createTracing, traceTools, type TraceObservation } from "../tracing/index.ts";

function emit(event: ChildEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function readRequest(): Promise<{ request: ChildRequest; lines: ReturnType<typeof createInterface> }> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const line = await new Promise<string>((resolve) => lines.once("line", resolve));
  return { request: JSON.parse(line) as ChildRequest, lines };
}

async function main(): Promise<void> {
  const { request, lines } = await readRequest();
  const tracing = createTracing({ exportMode: "immediate" });
  const python = new ChildPythonProxy(lines, emit);
  let agent: Agent | undefined;
  let abortReason: "user" | "timeout" | undefined;
  const receiveAbort = (line: string) => {
    try {
      const event = JSON.parse(line) as { type?: string; reason?: "user" | "timeout" };
      if (event.type === "abort") {
        abortReason = event.reason ?? "user";
        agent?.abort();
      }
    } catch { /* ignore non-JSON input */ }
  };
  lines.on("line", receiveAbort);
  try {
  const execute = async (observation?: TraceObservation) => {
  emit({ type: "status", state: "starting", message: `Starting ${request.profile.id}` });
  const runtime = createModelRuntime(tracing);
  const model = runtime.getModel(request.model);
  runtime.ensureThinking(model, request.thinking);
  const definitions = new Map(request.tools.map((tool) => [tool.name, tool]));
  const allowlist = request.profile.tools ?? [];
  const pythonAllowlist = allowlist.filter((name) => definitions.has(name));
  const runtimeContext = () => ({
    sessionId: request.sessionId,
    dataDirectory: request.dataDirectory,
    runId: request.runId,
    datasetPath: request.datasetPath,
    maxDistinctProducts: request.maxDistinctProducts,
    agentName: request.profile.id,
  });
  const pythonTools = createPythonAgentTools(definitions, pythonAllowlist, python, runtimeContext);
  const nativeToolSet = createNativeAgentToolSet(allowlist, {
    runtime,
    projectRoot: request.projectRoot,
    getRuntimeContext: () => ({ sessionId: request.sessionId, agentName: request.profile.id, projectRoot: request.projectRoot }),
    webSearchPolicy: request.profile.webSearchPolicy ?? (request.profile.id === "market_agent" ? "market" : "criteria"),
  });
  const terminalOutputTool = createTerminalOutputTool(request.profile, {
    python,
    runtimeContext: () => ({
      ...runtimeContext(),
      operation: request.profile.id === "market_agent" ? "publish_market" : undefined,
      searchStats: nativeToolSet.searchStats,
    }),
  });
  const contractStateTools = request.profile.contractState
    ? createContractStateTools(request.profile.contractState, request.contractState)
    : undefined;
  const tools = traceTools([
    ...pythonTools,
    ...nativeToolSet.tools,
    ...(contractStateTools?.tools ?? []),
    ...(terminalOutputTool ? [terminalOutputTool] : []),
  ], tracing);
  agent = new Agent({
    initialState: {
      systemPrompt: composeSystemPrompt(request.profile),
      model,
      thinkingLevel: request.thinking,
      tools,
      messages: [],
    },
    streamFn: runtime.streamSimple,
    sessionId: request.runId,
    toolExecution: "sequential",
  });

  agent.subscribe((event) => {
    if (event.type === "agent_start") emit({ type: "status", state: "running", message: `${request.profile.id} is working` });
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        emit({ type: "text_delta", delta: event.assistantMessageEvent.delta });
      } else if (event.assistantMessageEvent.type === "thinking_delta") {
        emit({ type: "thinking_delta", delta: event.assistantMessageEvent.delta });
      }
    } else if (event.type === "tool_execution_start") {
      if (event.toolName !== DEVELOPER_ISSUE_TOOL) emit({ type: "tool_start", name: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_end") {
      if (event.toolName === DEVELOPER_ISSUE_TOOL) return;
      const result = event.toolName === WEB_SEARCH_TOOL
        ? (event.isError ? "web_search failed" : "web_search completed")
        : event.result;
      emit({ type: "tool_end", name: event.toolName, result, isError: event.isError });
    }
  });

  await agent.prompt(request.task);
  const finalMessage = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
  if (finalMessage?.role === "assistant" && finalMessage.stopReason === "aborted") {
    const timedOut = abortReason === "timeout";
    observation?.fail?.(timedOut ? "Subagent attempt timed out." : "Subagent was aborted by the user.", !timedOut);
    throw new Error(timedOut ? `Subagent '${request.profile.id}' timed out.` : `Subagent '${request.profile.id}' was aborted.`);
  }
  let text = "";
  if (!request.profile.outputSchema) text = finalMessage ? messageText(finalMessage) : "";
  if (!text && agent.state.errorMessage) throw new Error(agent.state.errorMessage);

  if (request.profile.id === "research_agent") {
    if (!criteriaSearchSatisfied(nativeToolSet.searchStats)) {
      throw new Error("research_agent could not complete its mandatory four-query web_search research.");
    }
    if (nativeToolSet.searchStats.failed > 0) {
      try {
        await writeDeveloperIssue(request.projectRoot, {
          sessionId: request.sessionId,
          agentName: request.profile.id,
          projectRoot: request.projectRoot,
        }, {
          category: "insufficient_information",
          summary: "部分标准研究检索失败，已要求 research_agent 采用保守结果",
          context: `web_search succeeded=${nativeToolSet.searchStats.succeeded}, failed=${nativeToolSet.searchStats.failed}`,
          affected_entities: [request.profile.id],
          evidence: nativeToolSet.searchStats.failures,
          action_taken: "conservative_choice",
        });
      } catch {
        // Diagnostic persistence must never replace the child result/error.
      }
    }
  }

  let value: unknown;
  if (request.profile.outputSchema) {
    if (!terminalOutputTool?.state.submitted) {
      throw new Error(`Subagent '${request.profile.id}' must successfully call ${terminalOutputTool?.name ?? "submit_result"}.`);
    }
    value = terminalOutputTool.state.validatedValue;
  } else if (request.profile.contractState) {
    if (!contractStateTools?.store.isFinalized) {
      throw new Error(`Subagent '${request.profile.id}' must successfully call finalize_state.`);
    }
    value = contractStateTools.store.finalized();
  }
  observation?.update({
    output: value ?? text,
    metadata: { agent: request.profile.id, runId: request.runId, attempt: request.attempt, outcome: "success" },
  });
  emit({ type: "result", text, value, messages: sanitizeDeveloperDiagnosticMessages(agent.state.messages) });
  };
  const attributes = { input: request.task, metadata: { agent: request.profile.id, runId: request.runId, attempt: request.attempt } };
  if (request.traceContext) {
    await tracing.withRemoteObservation(`attempt-${request.attempt}`, "span", attributes, request.traceContext, execute);
  } else {
    await tracing.withObservation(`attempt-${request.attempt}`, "span", attributes, execute, request.sessionId);
  }
  } finally {
    await python.close();
    lines.removeListener("line", receiveAbort);
    await tracing.flush(1_000);
    await tracing.shutdown(1_000);
    lines.close();
    process.stdin.pause();
  }
}

main().catch((error) => {
  emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
