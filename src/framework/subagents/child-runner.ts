import { Agent } from "@earendil-works/pi-agent-core";
import { createModelRuntime } from "../model-runtime.ts";
import { createPythonAgentTools } from "../python-tools.ts";
import { createNativeAgentToolSet, criteriaSearchSatisfied, DEVELOPER_ISSUE_TOOL, SEMANTIC_MATCH_BATCH_TOOL, WEB_SEARCH_TOOL, writeDeveloperIssue } from "../native-tools.ts";
import { messageText, sanitizeDeveloperDiagnosticMessages } from "../content.ts";
import { createTerminalOutputTool } from "../terminal-output.ts";
import { createContractStateTools, PATCH_STATE_BATCH_TOOL, PATCH_STATE_TOOL, type ContractItem, type ContractState } from "../contract-state.ts";
import { createSemanticMatchBatchTool, type SemanticMatchBatchToolResult } from "../semantic-matcher.ts";
import { TaxonomySemanticMatchCache } from "../semantic-match-cache.ts";
import { composeSystemPrompt } from "../system-prompt.ts";
import type { ChildEvent, ChildRequest } from "./protocol.ts";
import { createInterface } from "node:readline";
import { ChildPythonProxy } from "./python-proxy.ts";
import { createTracing, traceTools, type TraceObservation } from "../tracing/index.ts";
import { MarketProductTransaction } from "./market-product-transaction.ts";

function emit(event: ChildEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contractItem(value: unknown): ContractItem | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function upsertsFromPatchArguments(toolName: string, params: unknown): ContractItem[] {
  if (!isRecord(params)) return [];
  if (toolName === PATCH_STATE_TOOL) {
    if (params.op !== "upsert") return [];
    const item = contractItem(params.item);
    return item ? [item] : [];
  }
  if (toolName !== PATCH_STATE_BATCH_TOOL || !Array.isArray(params.patches)) return [];
  return params.patches.flatMap((patch) => {
    if (!isRecord(patch) || patch.op !== "upsert") return [];
    const item = contractItem(patch.item);
    return item ? [item] : [];
  });
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
  const productTransaction = new MarketProductTransaction();
  let contractStateTools: ReturnType<typeof createContractStateTools> | undefined;
  const pythonTools = createPythonAgentTools(definitions, pythonAllowlist, python, runtimeContext, {
    onBeforeTool: (definition) => {
      if (definition.name !== "shopping_env") return;
      if (productTransaction.sampledProductId && !productTransaction.complete) {
        throw new Error("Complete the current product transaction with extract_product, semantic_match_batch, and patch_state or patch_state_batch before requesting another shopping_env sample.");
      }
    },
    onToolResult: (definition, result) => {
      if (definition.name !== "shopping_env") return;
      if (!result || typeof result !== "object" || Array.isArray(result) || typeof (result as Record<string, unknown>).item_id !== "string") {
        throw new Error("shopping_env returned no trusted active product id.");
      }
      productTransaction.sampled((result as Record<string, unknown>).item_id as string);
    },
  });
  const nativeToolSet = createNativeAgentToolSet(allowlist.filter((name) => name !== SEMANTIC_MATCH_BATCH_TOOL), {
    runtime,
    projectRoot: request.projectRoot,
    getRuntimeContext: () => ({ sessionId: request.sessionId, agentName: request.profile.id, projectRoot: request.projectRoot }),
    webSearchPolicy: request.profile.webSearchPolicy ?? (request.profile.id === "market_agent" ? "market" : "criteria"),
    onProductExtracted: async (input, output) => {
      if (request.profile.id !== "market_agent") return;
      if (!productTransaction.sampledProductId || input.item_id !== productTransaction.sampledProductId) {
        throw new Error("extract_product must use the OCR item_id returned by the current shopping_env transaction.");
      }
      if (!contractStateTools) throw new Error("extract_product requires initialized contract state tools.");
      productTransaction.extracted(input.item_id, output, contractStateTools.store.get());
    },
  });
  const terminalOutputTool = createTerminalOutputTool(request.profile, {
    python,
    runtimeContext: () => ({
      ...runtimeContext(),
      operation: request.profile.id === "market_agent" ? "publish_market" : undefined,
      searchStats: nativeToolSet.searchStats,
    }),
  });
  const publishContractState = request.profile.contractState
    ? async (state: ContractState) => {
      if (request.profile.id === "research_agent" && !criteriaSearchSatisfied(nativeToolSet.searchStats)) {
        throw new Error("research_agent must complete its mandatory four-query web_search research before finalize_state.");
      }
      if (request.profile.id === "market_agent" && productTransaction.sampledProductId && !productTransaction.complete) {
        throw new Error("market_agent must finish the current product transaction before finalize_state.");
      }
      const route = request.trustedRoute;
      if (!route) throw new Error("finalize_state requires a trusted route.");
      const document = {
        node: {
          id: route.node_id,
          name: route.node_name,
          path: route.node_path.split(">").map((part) => part.trim()).filter(Boolean),
        },
        criteria: state.criteria,
        attributes: state.attributes,
      };
      const validation = await python.validate(
        { id: "market_v1" },
        document,
        { operation: request.profile.id === "market_agent" ? "publish_market" : "persist_base" },
      );
      if (!validation.valid) throw new Error(`finalize_state ${request.profile.id === "market_agent" ? "market" : "base"} publication failed: ${validation.error}`);
    }
    : undefined;
  contractStateTools = request.profile.contractState
    ? createContractStateTools(request.profile.contractState, request.contractState, {
      onFinalize: publishContractState,
      runtime: request.profile.id === "market_agent"
        ? {
          onUpsert: (_kind, item, existing) => {
            const activeProductId = productTransaction.activeProductId;
            if (!activeProductId) throw new Error("market_agent patch_state requires a successfully extracted active product.");
            productTransaction.assertUpsertAllowed(_kind, item);
            const existingIds = existing && Array.isArray(existing.observed_product_ids)
              ? existing.observed_product_ids.filter((value): value is string => typeof value === "string")
              : [];
            const next = [...new Set([...existingIds, activeProductId])];
            return { observed_product_ids: next };
          },
        }
        : undefined,
    })
    : undefined;
  if (request.profile.id === "market_agent" && contractStateTools) {
    const patchStateTool = contractStateTools.tools.find((tool) => tool.name === PATCH_STATE_TOOL);
    if (!patchStateTool) throw new Error("market_agent requires patch_state.");
    const executePatchState = patchStateTool.execute.bind(patchStateTool);
    patchStateTool.execute = async (toolCallId, params, signal, onUpdate) => {
      const result = await executePatchState(toolCallId, params, signal, onUpdate);
      for (const item of upsertsFromPatchArguments(PATCH_STATE_TOOL, params)) productTransaction.upsertApplied(item);
      return result;
    };
    const patchStateBatchTool = contractStateTools.tools.find((tool) => tool.name === PATCH_STATE_BATCH_TOOL);
    if (!patchStateBatchTool) throw new Error("market_agent requires patch_state_batch.");
    const executePatchStateBatch = patchStateBatchTool.execute.bind(patchStateBatchTool);
    patchStateBatchTool.execute = async (toolCallId, params, signal, onUpdate) => {
      const result = await executePatchStateBatch(toolCallId, params, signal, onUpdate);
      // Only mark candidates after the store has committed the complete batch.
      for (const item of upsertsFromPatchArguments(PATCH_STATE_BATCH_TOOL, params)) productTransaction.upsertApplied(item);
      return result;
    };
  }
  const semanticMatchBatchTool = request.profile.id === "market_agent"
    && contractStateTools
    && allowlist.includes(SEMANTIC_MATCH_BATCH_TOOL)
    ? createSemanticMatchBatchTool({
      store: contractStateTools.store,
      runtime,
      modelId: request.model,
      sessionId: request.runId,
      cache: request.trustedRoute
        ? new TaxonomySemanticMatchCache({ runtimeData: request.dataDirectory, nodeId: request.trustedRoute.node_id, mode: "readWrite" })
      : undefined,
      getActiveProductId: () => productTransaction.activeProductId,
      onBeforeResolve: () => {
        if (productTransaction.batchResolved) {
          throw new Error("semantic_match_batch may be called at most once for each product.");
        }
      },
      onResolved: async (result: SemanticMatchBatchToolResult) => {
        productTransaction.resolved(result);
      },
    })
    : undefined;
  const tools = traceTools([
    ...pythonTools,
    ...nativeToolSet.tools,
    ...(contractStateTools?.tools ?? []),
    ...(semanticMatchBatchTool ? [semanticMatchBatchTool] : []),
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
