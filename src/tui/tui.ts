import type { AgentEvent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Markdown,
  ProcessTerminal,
  SelectList,
  Text,
  TuiMainScreen,
  matchesKey,
  type OverlayHandle,
  type SelectItem,
  type SlashCommand,
  type TUI,
} from "@earendil-works/pi-tui";
import { messageText } from "../framework/content.ts";
import { colors, editorTheme, markdownTheme, selectTheme } from "./theme.ts";
import type { ShopAgent } from "../framework/shop-agent.ts";
import type { ShopAgentEvent } from "../framework/types.ts";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const COMMANDS: SlashCommand[] = [
  { name: "help", description: "Show available commands" },
  { name: "clear", description: "Clear visible transcript only" },
  { name: "new", description: "Create a new session" },
  { name: "resume", description: "Resume a project session", argumentHint: "[session-id]" },
  { name: "sessions", description: "List project sessions" },
  { name: "model", description: "Select or override an OpenCode Go model", argumentHint: "[agent] [model]" },
  { name: "thinking", description: "Set reasoning level", argumentHint: "[agent] <level>" },
  { name: "agents", description: "List configured agents" },
  { name: "runs", description: "List subagent runs" },
  { name: "abort", description: "Abort the active run" },
  { name: "exit", description: "Save and exit" },
];

export class ShopAgentTui {
  private readonly app: ShopAgent;
  private readonly debug: boolean;
  private readonly tui: TUI;
  private readonly transcript = new Container();
  private readonly status = new Text();
  private readonly editor: Editor;
  private assistant?: Markdown;
  private assistantText = "";
  private overlay?: OverlayHandle;
  private stopped = false;
  private resolveExit?: () => void;
  private readonly unsubscribe: () => void;

  constructor(app: ShopAgent, debug = false) {
    this.app = app;
    this.debug = debug;
    this.tui = new TuiMainScreen(new ProcessTerminal());
    this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, app.config.cwd));
    this.editor.onSubmit = (text) => { void this.submit(text); };
    this.tui.addChild(new Text(colors.bold("Shop Agent") + colors.gray("  OpenCode Go · /help for commands"), 1, 1));
    this.tui.addChild(this.transcript);
    this.tui.addChild(this.status);
    this.tui.addChild(this.editor);
    this.tui.setFocus(this.editor);
    this.setReadyStatus();
    this.unsubscribe = app.subscribe((event) => this.onAppEvent(event));
    this.tui.addInputListener((data) => {
      if (!matchesKey(data, "ctrl+c")) return undefined;
      if (this.overlay) {
        this.closeOverlay();
      } else if (this.app.isBusy) {
        this.app.abort();
        this.addNotice("Abort requested.", "warn");
      } else {
        void this.stop();
      }
      return { consume: true };
    });
  }

  async run(): Promise<void> {
    this.addNotice(`Session ${this.app.currentSession.id.slice(0, 8)} · ${this.app.currentSession.model}`, "info");
    this.tui.start();
    return new Promise<void>((resolve) => { this.resolveExit = resolve; });
  }

  private async submit(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    this.editor.addToHistory(text);
    this.editor.setText("");
    if (text.startsWith("/")) {
      await this.handleCommand(text);
      return;
    }
    this.transcript.addChild(new Markdown(`**You**\n\n${text}`, 1, 1, markdownTheme));
    this.editor.disableSubmit = true;
    this.status.setText(colors.yellow("  ● thinking"));
    this.tui.requestRender();
    try {
      await this.app.prompt(text);
    } catch (error) {
      await this.handleError(error);
    } finally {
      this.editor.disableSubmit = false;
      this.setReadyStatus();
      this.tui.requestRender();
    }
  }

  private async onAppEvent(event: ShopAgentEvent): Promise<void> {
    if (event.type === "agent_event") this.onAgentEvent(event.event as AgentEvent);
    else if (event.type === "session_changed") this.setReadyStatus();
    else if (event.type === "notice") this.addNotice(event.message, "info");
    else if (event.type === "error") this.addNotice(event.message, "error");
  }

  private onAgentEvent(event: AgentEvent): void {
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.assistantText = "";
      this.assistant = new Markdown("**Shop Agent**\n\n", 1, 1, markdownTheme);
      this.transcript.addChild(this.assistant);
    } else if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") {
        this.assistantText += update.delta;
        this.assistant?.setText(`**Shop Agent**\n\n${this.assistantText}`);
      } else if (update.type === "thinking_delta") {
        this.status.setText(colors.magenta("  ◇ reasoning"));
      }
    } else if (event.type === "tool_execution_start") {
      this.status.setText(colors.yellow(`  ◇ ${event.toolName}`));
    } else if (event.type === "tool_execution_update") {
      const details = event.partialResult?.details as { state?: string; tool?: string } | undefined;
      this.status.setText(colors.yellow(`  ◇ subagent ${details?.tool ?? details?.state ?? "working"}`));
    } else if (event.type === "tool_execution_end") {
      this.addNotice(`${event.toolName} ${event.isError ? "failed" : "completed"}.`, event.isError ? "error" : "info");
    } else if (event.type === "agent_end") {
      this.setReadyStatus();
    }
    this.tui.requestRender();
  }

  private async handleCommand(input: string): Promise<void> {
    const [command, ...args] = input.slice(1).trim().split(/\s+/);
    try {
      switch (command.toLowerCase()) {
        case "help":
          this.showHelp();
          break;
        case "clear":
          this.transcript.clear();
          this.addNotice("Visible transcript cleared. Model context is unchanged.", "info");
          break;
        case "new": {
          const session = await this.app.newSession();
          this.transcript.clear();
          this.addNotice(`New session ${session.id.slice(0, 8)}.`, "info");
          break;
        }
        case "sessions":
          await this.showSessions(false);
          break;
        case "resume":
          if (args[0]) await this.resume(args[0]);
          else await this.showSessions(true);
          break;
        case "model":
          if (args.length === 0) this.showModelPicker(this.app.config.orchestrator);
          else if (args.length === 1) await this.changeModel(this.app.config.orchestrator, args[0]);
          else await this.changeModel(args[0], args[1]);
          break;
        case "thinking":
          if (args.length === 1) await this.changeThinking(this.app.config.orchestrator, args[0]);
          else if (args.length === 2) await this.changeThinking(args[0], args[1]);
          else this.addNotice("Usage: /thinking [agent] <level>", "warn");
          break;
        case "agents":
          this.showAgents();
          break;
        case "runs":
          this.showRuns();
          break;
        case "abort":
          if (this.app.isBusy) this.app.abort();
          else this.addNotice("No active run.", "warn");
          break;
        case "exit":
          await this.stop();
          break;
        default:
          this.addNotice(`Unknown command: /${command}. Use /help.`, "warn");
      }
    } catch (error) {
      await this.handleError(error);
    }
    this.tui.requestRender();
  }

  private showHelp(): void {
    const lines = COMMANDS.map((command) => `- \`/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}\` — ${command.description}`);
    this.transcript.addChild(new Markdown(`### Commands\n\n${lines.join("\n")}`, 1, 1, markdownTheme));
  }

  private async showSessions(picker: boolean): Promise<void> {
    const sessions = await this.app.listSessions();
    if (!sessions.length) {
      this.addNotice("No sessions found.", "warn");
      return;
    }
    if (!picker) {
      const lines = sessions.map((session) => `- \`${session.id.slice(0, 8)}\` ${session.title} — ${session.updatedAt}`);
      this.transcript.addChild(new Markdown(`### Sessions\n\n${lines.join("\n")}`, 1, 1, markdownTheme));
      return;
    }
    const items = sessions.map((session) => ({
      value: session.id,
      label: `${session.id.slice(0, 8)}  ${session.title}`,
      description: session.updatedAt,
    }));
    this.showPicker(items, (item) => { void this.resume(item.value); });
  }

  private async resume(id: string): Promise<void> {
    const session = await this.app.resumeSession(id);
    this.transcript.clear();
    this.renderHistory();
    this.addNotice(`Resumed ${session.id.slice(0, 8)} · ${session.title}`, "info");
  }

  private renderHistory(): void {
    for (const message of this.app.getMessages()) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const text = messageText(message);
      if (!text) continue;
      const label = message.role === "user" ? "You" : "Shop Agent";
      this.transcript.addChild(new Markdown(`**${label}**\n\n${text}`, 1, 1, markdownTheme));
    }
  }

  private showModelPicker(agentId: string): void {
    const items = this.app.listModels().map((model) => ({
      value: model.id,
      label: model.id,
      description: `${model.name}${model.reasoning ? " · reasoning" : ""}`,
    }));
    this.showPicker(items, (item) => { void this.changeModel(agentId, item.value); });
  }

  private async changeModel(agentId: string, modelId: string): Promise<void> {
    await this.app.setModel(agentId, modelId);
    this.addNotice(`${agentId} model → ${modelId}`, "info");
    this.setReadyStatus();
  }

  private async changeThinking(agentId: string, value: string): Promise<void> {
    if (!THINKING_LEVELS.includes(value as ThinkingLevel)) {
      throw new Error(`Invalid thinking level '${value}'. Use: ${THINKING_LEVELS.join(", ")}`);
    }
    await this.app.setThinking(agentId, value as ThinkingLevel);
    this.addNotice(`${agentId} thinking → ${value}`, "info");
    this.setReadyStatus();
  }

  private showAgents(): void {
    const lines = this.app.listAgents().map((agent) => `- **${agent.id}** (${agent.role}) — ${agent.description}  \n  tools: ${agent.tools.join(", ") || "none"}`);
    this.transcript.addChild(new Markdown(`### Agents\n\n${lines.join("\n")}`, 1, 1, markdownTheme));
  }

  private showRuns(): void {
    const runs = this.app.listRuns();
    const body = runs.length
      ? runs.map((run) => `- \`${run.id.slice(0, 8)}\` ${run.agent} — ${run.state}`).join("\n")
      : "No subagent runs in this process.";
    this.transcript.addChild(new Markdown(`### Runs\n\n${body}`, 1, 1, markdownTheme));
  }

  private showPicker(items: SelectItem[], onSelect: (item: SelectItem) => void): void {
    this.closeOverlay();
    const list = new SelectList(items, 12, selectTheme);
    list.onSelect = (item) => {
      this.closeOverlay();
      onSelect(item);
    };
    list.onCancel = () => this.closeOverlay();
    this.overlay = this.tui.showOverlay(list, { width: "85%", maxHeight: "70%", anchor: "center", margin: 2 });
  }

  private closeOverlay(): void {
    this.overlay?.hide();
    this.overlay = undefined;
    this.tui.setFocus(this.editor);
  }

  private addNotice(message: string, level: "info" | "warn" | "error"): void {
    const color = level === "error" ? colors.red : level === "warn" ? colors.yellow : colors.gray;
    this.transcript.addChild(new Text(color(`  ${message}`), 0, 1));
    this.tui.requestRender();
  }

  private setReadyStatus(): void {
    const session = this.app.currentSession;
    this.status.setText(colors.green(`  ● ready`) + colors.gray(`  ${session.model} · ${session.thinking} · ${session.id.slice(0, 8)}`));
  }

  private async handleError(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.addNotice(this.debug && error instanceof Error ? `${message}\n${error.stack ?? ""}` : message, "error");
    await this.app.logger.write("error", message, error);
  }

  private async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.app.isBusy) this.app.abort();
    this.unsubscribe();
    this.tui.stop();
    this.resolveExit?.();
  }
}
