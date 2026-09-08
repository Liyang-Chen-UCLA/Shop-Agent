import path from "node:path";
import { randomUUID } from "node:crypto";
import { Agent, type AgentEvent, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { loadConfig } from "./config.ts";
import { checkOpenCodeAuth, createModelRuntime, type ModelRuntime } from "./model-runtime.ts";
import { discoverPythonTools, createPythonAgentTools } from "./python-tools.ts";
import { createNativeAgentToolSet, isNativeToolName } from "./native-tools.ts";
import { isDeveloperDiagnosticAgentEvent, messageText, sanitizeDeveloperDiagnosticAgentEvent, sanitizeDeveloperDiagnosticMessages } from "./content.ts";
import { SessionStore } from "./session-store.ts";
import { Logger } from "./logger.ts";
import { SubagentManager } from "./subagents/manager.ts";
import { createDelegationTool } from "./subagents/tool.ts";
import { composeSystemPrompt } from "./system-prompt.ts";
import { PythonWorker } from "./python-worker.ts";
import { createTracing, traceTools, type TraceObservation, type Tracing } from "./tracing/index.ts";
import type {
  LoadedSession,
  ResolvedAgentProfile,
  ResolvedConfig,
  RunDetail,
  RunSummary,
  SessionMetadata,
  ShopAgentConfigInput,
  ShopAgentEvent,
  TaskState,
} from "./types.ts";

type Listener = (event: ShopAgentEvent) => void | Promise<void>;

export type CreateShopAgentOptions = {
  cwd?: string;
  configPath?: string;
  config?: ShopAgentConfigInput;
  skipAuthCheck?: boolean;
  /** Test/embedding hook; production tracing is otherwise created only from environment variables. */
  tracing?: Tracing;
};

export class ShopAgent {
  readonly config: ResolvedConfig;
  readonly runtime: ModelRuntime;
  readonly sessions: SessionStore;
  readonly logger: Logger;
  readonly subagents: SubagentManager;
  readonly python: PythonWorker;
  readonly tracing: Tracing;
  private readonly toolDefinitions: Map<string, import("./types.ts").PythonToolDefinition>;
  private readonly listeners = new Set<Listener>();
  private unsubscribeAgent?: () => void;
  private savedMessageCount = 0;
  private session: LoadedSession;
  private currentTurnTrace?: TraceObservation;
  agent: Agent;

  private constructor(
    config: ResolvedConfig,
    runtime: ModelRuntime,
    sessions: SessionStore,
    logger: Logger,
    subagents: SubagentManager,
    python: PythonWorker,
    tracing: Tracing,
    toolDefinitions: Map<string, import("./types.ts").PythonToolDefinition>,
    session: LoadedSession,
    agent: Agent,
  ) {
    this.config = config;
    this.runtime = runtime;
    this.sessions = sessions;
    this.logger = logger;
    this.subagents = subagents;
    this.python = python;
    this.tracing = tracing;
    this.toolDefinitions = toolDefinitions;
    this.session = session;
    this.agent = agent;
  }

  static async create(options: CreateShopAgentOptions = {}): Promise<ShopAgent> {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const config = await loadConfig(cwd, options.configPath, options.config);
    const definitions = await discoverPythonTools(cwd, config.toolDirectories);
    for (const profile of config.agents) {
      for (const tool of profile.tools ?? []) {
        if (tool !== "delegate_agent" && !definitions.has(tool) && !isNativeToolName(tool)) {
          throw new Error(`Agent '${profile.id}' references unknown Python tool '${tool}'.`);
        }
      }
    }
    const python = new PythonWorker(cwd, config.python, definitions);
    await python.start();
    const tracing = options.tracing ?? createTracing();
    try {
      const runtime = createModelRuntime(tracing);
      if (!options.skipAuthCheck) await checkOpenCodeAuth(runtime);
      const defaultModel = runtime.getModel(config.defaultModel);
      runtime.ensureThinking(defaultModel, config.defaultThinking);
      const dataDirectory = config.dataDirectory;
      const sessions = new SessionStore(dataDirectory);
      const logger = new Logger(dataDirectory);
      const session = await sessions.create(config.defaultModel, config.defaultThinking);
      const subagents = new SubagentManager(config, definitions, python, tracing);
      const placeholder = new Agent({ streamFn: runtime.streamSimple });
      const app = new ShopAgent(config, runtime, sessions, logger, subagents, python, tracing, definitions, session, placeholder);
      app.replaceAgent(app.buildAgent(session));
      return app;
    } catch (error) {
      try { await tracing.shutdown(); } catch { /* tracing must not mask startup errors */ }
      await python.close();
      throw error;
    }
  }

  private get orchestrator(): ResolvedAgentProfile {
    const profile = this.config.agents.find((item) => item.id === this.config.orchestrator);
    if (!profile) throw new Error(`Orchestrator profile not found: ${this.config.orchestrator}`);
    return profile;
  }

  private buildAgent(session: LoadedSession): Agent {
    const profile = this.orchestrator;
    const model = this.runtime.getModel(session.metadata.model);
    this.runtime.ensureThinking(model, session.metadata.thinking);
    const allowlist = profile.tools ?? [];
    const pythonAllowlist = allowlist.filter((name) => this.toolDefinitions.has(name));
    const pythonTools = createPythonAgentTools(
      this.toolDefinitions,
      pythonAllowlist,
      this.python,
      () => ({
        sessionId: this.session.metadata.id,
        dataDirectory: this.config.dataDirectory,
        datasetPath: this.config.datasetPath,
        maxDistinctProducts: this.config.maxDistinctProducts,
        agentName: profile.id,
      }),
    );
    const nativeTools = createNativeAgentToolSet(allowlist, {
      runtime: this.runtime,
      projectRoot: this.config.cwd,
      getRuntimeContext: () => ({
        sessionId: this.session.metadata.id,
        agentName: profile.id,
        projectRoot: this.config.cwd,
      }),
    });
    const tools = [...pythonTools];
    if (allowlist.includes("delegate_agent")) {
      tools.push(createDelegationTool(
        this.config.agents,
        this.subagents,
        () => this.session.metadata.agentOverrides,
        () => this.session.metadata.id,
      ));
    }
    tools.push(...nativeTools.tools);
    const tracedTools = traceTools(tools, this.tracing);
    return new Agent({
      initialState: {
        systemPrompt: composeSystemPrompt(profile),
        model,
        thinkingLevel: session.metadata.thinking,
        tools: tracedTools,
        messages: session.messages,
      },
      streamFn: this.runtime.streamSimple,
      sessionId: session.metadata.id,
      toolExecution: "sequential",
    });
  }

  private replaceAgent(agent: Agent): void {
    this.unsubscribeAgent?.();
    this.agent = agent;
    this.savedMessageCount = agent.state.messages.length;
    this.unsubscribeAgent = agent.subscribe(async (event) => {
      if (!isDeveloperDiagnosticAgentEvent(event)) {
        await this.emit({ type: "agent_event", event: sanitizeDeveloperDiagnosticAgentEvent(event) });
      }
      if (event.type === "agent_end") {
        const unsaved = this.agent.state.messages.slice(this.savedMessageCount);
        await this.sessions.appendMessages(this.session, sanitizeDeveloperDiagnosticMessages(unsaved));
        this.savedMessageCount = this.agent.state.messages.length;
      }
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async emit(event: ShopAgentEvent): Promise<void> {
    for (const listener of this.listeners) await listener(event);
  }

  get currentSession(): SessionMetadata {
    return this.session.metadata;
  }

  get isBusy(): boolean {
    return this.agent.state.isStreaming;
  }

  async prompt(text: string): Promise<void> {
    if (this.isBusy) throw new Error("The agent is already working. Use /abort before sending another prompt.");
    const before = this.agent.state.messages.length;
    try {
      await this.tracing.withObservation("shop-turn", "agent", {
        input: text,
        metadata: { orchestrator: this.orchestrator.id },
      }, async (observation) => {
        this.currentTurnTrace = observation;
        await this.agent.prompt(text);
        const messages = this.agent.state.messages.slice(before);
        const assistant = [...messages].reverse().find((message) => message.role === "assistant");
        const output = assistant ? messageText(assistant) : "";
        const stopReason = assistant?.role === "assistant" ? assistant.stopReason : undefined;
        const aborted = stopReason === "aborted";
        observation?.update({
          output,
          level: aborted ? "WARNING" : this.agent.state.errorMessage ? "ERROR" : "DEFAULT",
          statusMessage: this.agent.state.errorMessage ?? stopReason ?? "completed",
          metadata: { orchestrator: this.orchestrator.id, outcome: aborted ? "aborted" : this.agent.state.errorMessage ? "error" : "success" },
        });
        if (aborted || this.agent.state.errorMessage) observation?.fail?.(this.agent.state.errorMessage ?? "User aborted", aborted);
      }, this.session.metadata.id);
    } finally {
      this.currentTurnTrace = undefined;
      try { await this.tracing.flush(); } catch { /* tracing must not affect a shop turn */ }
    }
  }

  abort(): void {
    this.agent.abort();
  }

  async close(): Promise<void> {
    this.abort();
    this.unsubscribeAgent?.();
    this.unsubscribeAgent = undefined;
    await this.subagents.close();
    await this.python.close();
    try { await this.tracing.shutdown(); } catch { /* tracing must not affect shutdown */ }
  }

  async newSession(): Promise<SessionMetadata> {
    if (this.isBusy) throw new Error("Abort the current run before creating a new session.");
    this.session = await this.sessions.create(this.config.defaultModel, this.config.defaultThinking);
    this.replaceAgent(this.buildAgent(this.session));
    await this.emit({ type: "session_changed", session: this.session.metadata });
    return this.session.metadata;
  }

  async resumeSession(idOrPrefix: string): Promise<SessionMetadata> {
    if (this.isBusy) throw new Error("Abort the current run before resuming another session.");
    this.session = await this.sessions.load(idOrPrefix);
    this.replaceAgent(this.buildAgent(this.session));
    await this.emit({ type: "session_changed", session: this.session.metadata });
    return this.session.metadata;
  }

  async listSessions(): Promise<SessionMetadata[]> {
    return this.sessions.list();
  }

  listModels(): { id: string; name: string; reasoning: boolean }[] {
    return this.runtime.listModels().map(({ id, name, reasoning }) => ({ id, name, reasoning }));
  }

  listAgents(): { id: string; role: string; description: string; tools: string[] }[] {
    return this.config.agents.map(({ id, role, description, tools }) => ({ id, role, description, tools: tools ?? [] }));
  }

  listRuns(): RunSummary[] {
    return this.subagents.listRuns();
  }

  getRun(idOrPrefix: string): RunDetail {
    return this.subagents.getRun(idOrPrefix);
  }

  async getTaskState(signal?: AbortSignal): Promise<TaskState> {
    const tool = this.agent.state.tools.find((item) => item.name === "task_state_get");
    if (!tool) throw new Error("The orchestrator does not expose task_state_get.");
    const result = await tool.execute(`tui-task-state-${randomUUID()}`, {}, signal);
    const content = result.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("task_state_get returned no text result.");
    const envelope = JSON.parse(content.text) as { state?: TaskState };
    if (!envelope.state) throw new Error("task_state_get returned no state.");
    return envelope.state;
  }

  async setModel(agentId: string, modelId: string): Promise<void> {
    const model = this.runtime.getModel(modelId);
    const target = this.config.agents.find((item) => item.id === agentId);
    if (!target) throw new Error(`Unknown agent: ${agentId}`);
    const currentThinking = agentId === this.config.orchestrator
      ? this.session.metadata.thinking
      : this.session.metadata.agentOverrides[agentId]?.thinking ?? target.thinking ?? this.config.defaultThinking;
    const thinking = this.runtime.resolveThinking(model, currentThinking);
    if (agentId === this.config.orchestrator) {
      this.session.metadata.model = modelId;
      this.session.metadata.thinking = thinking;
      this.agent.state.model = model;
      this.agent.state.thinkingLevel = thinking;
    } else {
      this.session.metadata.agentOverrides[agentId] = {
        ...this.session.metadata.agentOverrides[agentId],
        model: modelId,
        thinking,
      };
    }
    await this.sessions.saveMetadata(this.session.metadata);
  }

  async setThinking(agentId: string, thinking: ThinkingLevel): Promise<void> {
    const target = this.config.agents.find((item) => item.id === agentId);
    if (!target) throw new Error(`Unknown agent: ${agentId}`);
    const modelId = agentId === this.config.orchestrator
      ? this.session.metadata.model
      : this.session.metadata.agentOverrides[agentId]?.model ?? target.model?.id ?? this.config.defaultModel;
    const model = this.runtime.getModel(modelId);
    this.runtime.ensureThinking(model, thinking);
    if (agentId === this.config.orchestrator) {
      this.session.metadata.thinking = thinking;
      this.agent.state.thinkingLevel = thinking;
    } else {
      this.session.metadata.agentOverrides[agentId] = {
        ...this.session.metadata.agentOverrides[agentId],
        thinking,
      };
    }
    await this.sessions.saveMetadata(this.session.metadata);
  }

  getMessages() {
    return sanitizeDeveloperDiagnosticMessages(this.agent.state.messages);
  }
}

export async function createShopAgent(options: CreateShopAgentOptions = {}): Promise<ShopAgent> {
  return ShopAgent.create(options);
}

export type { AgentEvent };
