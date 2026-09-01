import { spawn } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Agent, type AgentEvent, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { loadConfig } from "./config.ts";
import { checkOpenCodeAuth, createModelRuntime, type ModelRuntime } from "./model-runtime.ts";
import { discoverPythonTools, createPythonAgentTools } from "./python-tools.ts";
import { createNativeAgentToolSet, isNativeToolName } from "./native-tools.ts";
import { isDeveloperDiagnosticAgentEvent, sanitizeDeveloperDiagnosticAgentEvent, sanitizeDeveloperDiagnosticMessages } from "./content.ts";
import { SessionStore } from "./session-store.ts";
import { Logger } from "./logger.ts";
import { SubagentManager } from "./subagents/manager.ts";
import { createDelegationTool } from "./subagents/tool.ts";
import { composeSystemPrompt } from "./system-prompt.ts";
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

async function verifyPythonExecutable(executable: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["-c", "pass"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", (error) => reject(new Error("Python executable '" + executable + "' is not available: " + error.message)));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Python executable '" + executable + "' exited with code " + code + " during startup check."));
    });
  });
}

export type CreateShopAgentOptions = {
  cwd?: string;
  configPath?: string;
  config?: ShopAgentConfigInput;
  skipAuthCheck?: boolean;
};

export class ShopAgent {
  readonly config: ResolvedConfig;
  readonly runtime: ModelRuntime;
  readonly sessions: SessionStore;
  readonly logger: Logger;
  readonly subagents: SubagentManager;
  private readonly toolDefinitions: Map<string, import("./types.ts").PythonToolDefinition>;
  private readonly listeners = new Set<Listener>();
  private unsubscribeAgent?: () => void;
  private savedMessageCount = 0;
  private session: LoadedSession;
  agent: Agent;

  private constructor(
    config: ResolvedConfig,
    runtime: ModelRuntime,
    sessions: SessionStore,
    logger: Logger,
    subagents: SubagentManager,
    toolDefinitions: Map<string, import("./types.ts").PythonToolDefinition>,
    session: LoadedSession,
    agent: Agent,
  ) {
    this.config = config;
    this.runtime = runtime;
    this.sessions = sessions;
    this.logger = logger;
    this.subagents = subagents;
    this.toolDefinitions = toolDefinitions;
    this.session = session;
    this.agent = agent;
  }

  static async create(options: CreateShopAgentOptions = {}): Promise<ShopAgent> {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const config = await loadConfig(cwd, options.configPath, options.config);
    await verifyPythonExecutable(config.python.executable);
    const runtime = createModelRuntime();
    if (!options.skipAuthCheck) await checkOpenCodeAuth(runtime);
    const defaultModel = runtime.getModel(config.defaultModel);
    runtime.ensureThinking(defaultModel, config.defaultThinking);
    const definitions = await discoverPythonTools(cwd, config.toolDirectories);
    for (const profile of config.agents) {
      for (const tool of profile.tools ?? []) {
        if (tool !== "delegate_agent" && !definitions.has(tool) && !isNativeToolName(tool)) {
          throw new Error(`Agent '${profile.id}' references unknown Python tool '${tool}'.`);
        }
      }
    }
    const dataDirectory = path.resolve(cwd, config.dataDirectory);
    const sessions = new SessionStore(dataDirectory);
    const logger = new Logger(dataDirectory);
    const session = await sessions.create(config.defaultModel, config.defaultThinking);
    const subagents = new SubagentManager(config, definitions);
    const placeholder = new Agent({ streamFn: runtime.models.streamSimple.bind(runtime.models) });
    const app = new ShopAgent(config, runtime, sessions, logger, subagents, definitions, session, placeholder);
    app.replaceAgent(app.buildAgent(session));
    return app;
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
      this.config.python,
      () => ({
        sessionId: this.session.metadata.id,
        dataDirectory: path.resolve(this.config.cwd, this.config.dataDirectory),
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
    return new Agent({
      initialState: {
        systemPrompt: composeSystemPrompt(profile),
        model,
        thinkingLevel: session.metadata.thinking,
        tools,
        messages: session.messages,
      },
      streamFn: this.runtime.models.streamSimple.bind(this.runtime.models),
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
    await this.agent.prompt(text);
  }

  abort(): void {
    this.agent.abort();
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
    this.runtime.ensureThinking(model, currentThinking);
    if (agentId === this.config.orchestrator) {
      this.session.metadata.model = modelId;
      this.agent.state.model = model;
    } else {
      this.session.metadata.agentOverrides[agentId] = {
        ...this.session.metadata.agentOverrides[agentId],
        model: modelId,
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
