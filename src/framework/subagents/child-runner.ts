import { Agent } from "@earendil-works/pi-agent-core";
import { createModelRuntime } from "../model-runtime.ts";
import { createPythonAgentTools } from "../python-tools.ts";
import { createNativeAgentToolSet, criteriaSearchSatisfied, DEVELOPER_ISSUE_TOOL, WEB_SEARCH_TOOL, writeDeveloperIssue } from "../native-tools.ts";
import { messageText, sanitizeDeveloperDiagnosticMessages } from "../content.ts";
import { createOutputValidationController } from "../output-validation-hook.ts";
import { validateJsonSchema } from "../schema.ts";
import { composeSystemPrompt } from "../system-prompt.ts";
import type { ChildEvent, ChildRequest } from "./protocol.ts";

function emit(event: ChildEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function readRequest(): Promise<ChildRequest> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return JSON.parse(input) as ChildRequest;
}

async function main(): Promise<void> {
  const request = await readRequest();
  emit({ type: "status", state: "starting", message: `Starting ${request.profile.id}` });
  const runtime = createModelRuntime();
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
  const pythonTools = createPythonAgentTools(definitions, pythonAllowlist, request.python, runtimeContext);
  const nativeToolSet = createNativeAgentToolSet(allowlist, {
    runtime,
    projectRoot: request.projectRoot,
    getRuntimeContext: () => ({ sessionId: request.sessionId, agentName: request.profile.id, projectRoot: request.projectRoot }),
    webSearchPolicy: request.profile.webSearchPolicy ?? (request.profile.id === "market_agent" ? "market" : "criteria"),
  });
  const tools = [...pythonTools, ...nativeToolSet.tools];
  let agent: Agent;
  const validationController = createOutputValidationController({
    profile: request.profile,
    python: request.python,
    projectRoot: request.projectRoot,
    runtimeContext: () => ({
      ...runtimeContext(),
      operation: request.profile.id === "market_agent" ? "publish_market" : undefined,
      searchStats: nativeToolSet.searchStats,
    }),
    steer: (message) => agent.steer(message),
  });
  agent = new Agent({
    initialState: {
      systemPrompt: composeSystemPrompt(request.profile),
      model,
      thinkingLevel: request.thinking,
      tools,
      messages: [],
    },
    streamFn: runtime.models.streamSimple.bind(runtime.models),
    sessionId: request.runId,
    toolExecution: "sequential",
    shouldStopAfterTurn: validationController.shouldStopAfterTurn,
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
  if (validationController.state.terminalError) throw new Error(validationController.state.terminalError);
  const finalMessage = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
  const text = finalMessage ? messageText(finalMessage) : "";
  if (!text && agent.state.errorMessage) throw new Error(agent.state.errorMessage);

  if (request.profile.id === "criteria_agent") {
    if (!criteriaSearchSatisfied(nativeToolSet.searchStats)) {
      throw new Error("criteria_agent could not complete its mandatory four-query web_search research.");
    }
    if (nativeToolSet.searchStats.failed > 0) {
      try {
        await writeDeveloperIssue(request.projectRoot, {
          sessionId: request.sessionId,
          agentName: request.profile.id,
          projectRoot: request.projectRoot,
        }, {
          category: "insufficient_information",
          summary: "部分标准研究检索失败，已要求 criteria_agent 采用保守结果",
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
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`Subagent '${request.profile.id}' must return JSON matching its output schema.`);
    }
    if (!validationController.state.validationSucceeded) {
      const validation = validateJsonSchema(request.profile.outputSchema, value);
      if (!validation.valid) throw new Error(`Subagent output validation failed: ${validation.error}`);
    } else {
      value = validationController.state.validatedValue;
    }
  }
  emit({ type: "result", text, value, messages: sanitizeDeveloperDiagnosticMessages(agent.state.messages) });
}

main().catch((error) => {
  emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
