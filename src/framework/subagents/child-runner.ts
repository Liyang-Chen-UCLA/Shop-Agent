import { Agent } from "@earendil-works/pi-agent-core";
import { createModelRuntime } from "../model-runtime.ts";
import { createPythonAgentTools } from "../python-tools.ts";
import { messageText } from "../content.ts";
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
  const tools = createPythonAgentTools(definitions, request.profile.tools ?? [], request.python);
  const agent = new Agent({
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
      emit({ type: "tool_start", name: event.toolName });
    } else if (event.type === "tool_execution_end") {
      emit({ type: "tool_end", name: event.toolName, isError: event.isError });
    }
  });

  await agent.prompt(request.task);
  const finalMessage = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
  const text = finalMessage ? messageText(finalMessage) : "";
  if (!text && agent.state.errorMessage) throw new Error(agent.state.errorMessage);

  let value: unknown;
  if (request.profile.outputSchema) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`Subagent '${request.profile.id}' must return JSON matching its output schema.`);
    }
    const validation = validateJsonSchema(request.profile.outputSchema, value);
    if (!validation.valid) throw new Error(`Subagent output validation failed: ${validation.error}`);
  }
  emit({ type: "result", text, value, messages: agent.state.messages });
}

main().catch((error) => {
  emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
