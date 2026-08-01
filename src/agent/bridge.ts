import { isAbsolute, basename, resolve as resolvePath } from "node:path";
import * as vscode from "vscode";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ChatEvent, ChatState, ChatStats, HostMessage, ResourceSection, SessionListItem, WebviewMessage } from "../shared/protocol.js";
import { loginFlow, logoutFlow } from "./auth.js";
import { collectSlashCommands, runBuiltinCommand } from "./commands.js";
import { navigateSessionTree } from "./session-tree.js";
import type { OriginalContentProvider } from "./diff-view.js";
import { openEditDiff } from "./diff-view.js";
import { ProjectFileIndex } from "./project-files.js";
import type { PiRuntime } from "./runtime.js";
import type { SubagentObserver, SubagentOutcome, SubagentRun } from "./subagent.js";

export interface BridgeHost {
  post(message: HostMessage): void;
  log(message: string): void;
}

/**
 * Translates `AgentSession` events into webview messages and applies inbound
 * webview commands to the runtime.
 *
 * Re-subscribes and re-binds extensions on every session replacement, as the
 * SDK requires (`vscode-pi-design.md` §4).
 */
export class ChatBridge implements vscode.Disposable, SubagentObserver {
  private unsubscribe?: () => void;
  private disposed = false;
  private displayedSession?: AgentSession;
  private activeDelegation?: SubagentRun;
  /** Only the newest async state snapshot may reach the webview. */
  private statePostVersion = 0;
  /** Replay buffers keep parent and child transcripts intact while viewing either. */
  private readonly histories = new Map<string, ChatEvent[]>();
  /** Arguments of in-flight tool calls, used to resolve the edited file path. */
  private readonly pendingToolArgs = new Map<string, unknown>();
  private readonly projectFiles: ProjectFileIndex;

  constructor(
    private readonly runtime: PiRuntime,
    private readonly host: BridgeHost,
    private readonly diffProvider: OriginalContentProvider,
  ) {
    this.projectFiles = new ProjectFileIndex((message) => host.log(message));
    runtime.subagents.setObserver(this);
  }

  /** Subscribe to the current session and push the initial state. */
  async attach(): Promise<void> {
    this.unsubscribe?.();
    await this.runtime.bindExtensions();
    const session = this.runtime.session;
    this.displayedSession = session;
    this.histories.clear();
    this.histories.set(session.sessionId, buildHistoryEvents(session.messages, this.runtime.cwd));
    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(session, event));
    this.postHistory();
    this.postCommands();
    this.postResources();
    await this.postState();
  }

  /**
   * The CLI-style startup listing ([Context] / [Skills] / [Prompts] /
   * [Extensions] / [Themes]), pinned above the transcript in the webview.
   */
  postResources(): void {
    try {
      this.host.post({ type: "resources", sections: collectResourceSections(this.runtime) });
    } catch (error) {
      this.host.log(`failed to collect resources: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Push the `/` autocomplete catalogue (built-ins, prompts, extensions, skills). */
  postCommands(): void {
    try {
      this.host.post({ type: "commands", items: collectSlashCommands(this.runtime.session) });
    } catch (error) {
      this.host.log(`failed to collect slash commands: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Replay the persisted transcript so a resumed session is not shown empty. */
  postHistory(): void {
    const session = this.displayedSession ?? this.runtime.session;
    const events = this.histories.get(session.sessionId) ?? buildHistoryEvents(session.messages, this.runtime.cwd);
    this.histories.set(session.sessionId, events);
    this.host.post({ type: "history", events: [...events] });
  }

  async postState(): Promise<void> {
    // getAvailableModels() is asynchronous. Without a version check, a state
    // snapshot started while the child is displayed can arrive after the child
    // finishes and overwrite the authoritative parent state.
    const postVersion = ++this.statePostVersion;
    const session = this.displayedSession ?? this.runtime.session;
    const model = session.model as { id?: string; provider?: string } | undefined;
    let needsAuth = false;
    try {
      needsAuth = (await this.runtime.getAvailableModels()).length === 0;
    } catch {
      // Availability check failing must not block the chat UI.
    }
    if (postVersion !== this.statePostVersion || this.disposed) return;
    const state: ChatState = {
      ready: true,
      cwd: this.runtime.cwd,
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      modelId: model?.id,
      providerId: model?.provider,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      needsAuth,
      messageCount: session.messages.length,
      delegation: this.delegationState(session),
      inputDisabled: Boolean(this.activeDelegation && session === this.activeDelegation.child),
      stats: this.collectStats(session),
    };
    this.host.post({ type: "state", state });
  }

  /** Numbers for the CLI-style footer status line. */
  private collectStats(session: AgentSession): ChatStats | undefined {
    try {
      const stats = session.getSessionStats();
      const usage = session.getContextUsage();
      const cacheable = stats.tokens.cacheRead + stats.tokens.input;
      return {
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        cacheRead: stats.tokens.cacheRead,
        cacheWrite: stats.tokens.cacheWrite,
        cacheHitPercent: cacheable > 0 ? (stats.tokens.cacheRead / cacheable) * 100 : undefined,
        cost: stats.cost,
        contextPercent: usage?.percent ?? undefined,
        contextWindow: usage?.contextWindow,
      };
    } catch {
      return undefined;
    }
  }

  private emit(session: AgentSession, event: ChatEvent): void {
    if (this.disposed) return;
    const history = this.histories.get(session.sessionId) ?? buildHistoryEvents(session.messages, this.runtime.cwd);
    history.push(event);
    this.histories.set(session.sessionId, history);
    if ((this.displayedSession ?? this.runtime.session) === session) {
      this.host.post({ type: "event", event });
    }
  }

  private onSessionEvent(session: AgentSession, event: AgentSessionEvent): void {
    const toolKey = (id: string) => `${session.sessionId}:${id}`;
    switch (event.type) {
      case "agent_start":
        this.emit(session, { kind: "agent_start" });
        void this.postState();
        break;
      case "agent_end":
        // A low-level run can end before Pi retries or continues with
        // compaction. The webview closes the execution process on the later
        // agent_settled event instead.
        this.emit(session, { kind: "agent_end" });
        void this.postState();
        break;
      // `agent_end` can still be followed by retries, compaction, or queued
      // prompts. Refresh when the SDK reports that automatic continuations
      // have settled so the UI receives the current streaming state.
      case "agent_settled":
        this.emit(session, { kind: "agent_settled" });
        void this.postState();
        void this.refreshSessions();
        break;
      case "message_start":
        this.emit(session, { kind: "assistant_start" });
        break;
      case "message_update": {
        const inner = event.assistantMessageEvent;
        if (inner.type === "text_delta") this.emit(session, { kind: "text_delta", delta: inner.delta });
        else if (inner.type === "thinking_delta") this.emit(session, { kind: "thinking_delta", delta: inner.delta });
        break;
      }
      case "message_end":
        this.emit(session, { kind: "assistant_end" });
        // Provider failures are encoded on the completed assistant message.
        // AgentState.errorMessage is only updated at turn_end, so it is not
        // available yet when message_end is delivered.
        if (event.message.role === "assistant" && event.message.stopReason === "error" && event.message.errorMessage) {
          this.emit(session, { kind: "error", text: event.message.errorMessage });
        }
        break;
      case "tool_execution_start":
        this.pendingToolArgs.set(toolKey(event.toolCallId), event.args);
        this.emit(session, { kind: "tool_start", id: event.toolCallId, name: event.toolName, args: event.args });
        break;
      case "tool_execution_update":
        this.emit(session, { kind: "tool_update", id: event.toolCallId, text: resultText(event.partialResult) });
        break;
      case "tool_execution_end": {
        const details = (event.result?.details ?? {}) as { patch?: string };
        const key = toolKey(event.toolCallId);
        const args = this.pendingToolArgs.get(key);
        this.pendingToolArgs.delete(key);
        this.emit(session, {
          kind: "tool_end",
          id: event.toolCallId,
          name: event.toolName,
          isError: event.isError,
          text: resultText(event.result),
          patch: typeof details.patch === "string" ? details.patch : undefined,
          path: toolFilePath(args, this.runtime.cwd),
        });
        break;
      }
      case "queue_update":
        this.emit(session, { kind: "queue_update", steering: [...event.steering], followUp: [...event.followUp] });
        break;
      case "compaction_start":
        this.emit(session, { kind: "status", text: `compacting context (${event.reason})...` });
        break;
      case "compaction_end":
        this.emit(session, { kind: "status", text: event.errorMessage ? `compaction failed: ${event.errorMessage}` : "compaction done" });
        break;
      case "auto_retry_start":
        this.emit(session, { kind: "status", text: `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}` });
        break;
      case "auto_retry_end":
        this.emit(session, { kind: "status", text: event.success ? "retry succeeded" : `retry failed: ${event.finalError ?? "unknown"}` });
        break;
      default:
        break;
    }
  }

  onSubagentStarted(run: SubagentRun): void {
    this.activeDelegation = run;
    this.histories.set(run.child.sessionId, [{ kind: "user_message", text: run.task }]);
    this.displayedSession = run.child;
    this.postHistory();
    void this.postState();
    void this.refreshSessions();
  }

  onSubagentEvent(run: SubagentRun, event: AgentSessionEvent): void {
    if (this.activeDelegation !== run) return;
    this.onSessionEvent(run.child, event);
  }

  onSubagentFinished(run: SubagentRun, outcome: SubagentOutcome): void {
    if (this.activeDelegation !== run) return;
    const childStatus = outcome.status === "completed"
      ? "Subagent completed."
      : outcome.status === "stopped"
        ? "Subagent stopped."
        : outcome.text;
    this.emit(run.child, { kind: outcome.status === "failed" ? "error" : "status", text: childStatus });
    this.activeDelegation = undefined;
    this.displayedSession = run.parent;
    this.postHistory();
    void this.postState();
    void this.refreshSessions();
  }

  private delegationState(session: AgentSession): ChatState["delegation"] {
    const run = this.activeDelegation;
    if (!run) return undefined;
    if (session === run.parent) {
      return {
        role: "parent",
        title: run.title,
        peerSessionId: run.child.sessionId,
        peerSessionFile: run.child.sessionFile,
      };
    }
    if (session === run.child) {
      return {
        role: "child",
        title: run.title,
        peerSessionId: run.parent.sessionId,
        peerSessionFile: run.parent.sessionFile,
      };
    }
    return undefined;
  }

  private showDelegationSession(target: "parent" | "child"): void {
    const run = this.activeDelegation;
    if (!run) return;
    this.displayedSession = target === "parent" ? run.parent : run.child;
    this.postHistory();
    this.postCommands();
    this.postResources();
    void this.postState();
  }

  /** Handle a message coming from the webview. */
  async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.postHistory();
        this.postCommands();
        this.postResources();
        await this.postState();
        break;
      case "prompt":
        await this.sendPrompt(message.text, message.streamingBehavior, message.references);
        break;
      case "listProjectFiles":
        await this.listProjectFiles(message.requestId, message.query, message.includeIgnored);
        break;
      case "abort":
        await this.abortDisplayedSession();
        await this.postState();
        break;
      case "newSession":
        if (this.guardStreaming()) break;
        await this.runtime.newSession();
        await this.attach();
        break;
      case "listSessions":
        this.host.post({ type: "sessions", items: await this.listSessions() });
        break;
      case "listCommands":
        this.postCommands();
        break;
      case "resumeSession":
        if (this.guardStreaming()) break;
        await this.runtime.switchSession(message.file);
        await this.attach();
        break;
      case "showDelegationSession":
        this.showDelegationSession(message.target);
        break;
      case "deleteSession":
        await this.deleteSession(message.file);
        break;
      case "openSessionTree":
        if (this.guardStreaming()) break;
        await navigateSessionTree(this.runtime, this.builtinActions());
        await this.attach();
        break;
      case "pickModel":
        await this.pickModel();
        break;
      case "login":
        await this.login();
        break;
      case "logout":
        await this.logout();
        break;
      case "pickThinkingLevel":
        await this.pickThinkingLevel();
        break;
      case "openDiff":
        await openEditDiff(this.diffProvider, message.path, message.patch);
        break;
      case "openFile":
        await vscode.window.showTextDocument(vscode.Uri.file(message.path));
        break;
    }
  }

  private async abortDisplayedSession(): Promise<void> {
    const run = this.activeDelegation;
    if (!run) {
      await this.runtime.session.abort();
      return;
    }
    if (this.displayedSession === run.child) {
      await this.runtime.subagents.stopChild();
      return;
    }
    // Stopping from the parent means stopping the entire serial task line.
    await this.runtime.subagents.stopForParent();
    run.parent.clearQueue();
    await run.parent.abort();
  }

  /**
   * Single-session mode: while a run is in progress the active session must
   * not be replaced (switch/new/fork would abort the run mid-flight).
   */
  private guardStreaming(): boolean {
    if (!this.runtime.session.isStreaming) return false;
    const zh = vscode.env.language.toLowerCase().startsWith("zh");
    vscode.window.showWarningMessage(
      zh
        ? "Pi Agent Chat 仅支持单会话模式：请先停止当前会话的运行，再切换或新建会话。"
        : "Pi Agent Chat is single-session: stop the current run before switching or starting a session.",
    );
    return true;
  }

  /** Answer a webview @ picker query; errors are reported inline, never thrown. */
  private async listProjectFiles(requestId: number, query: string, includeIgnored: boolean): Promise<void> {
    try {
      const items = await this.projectFiles.search(this.runtime.cwd, query, includeIgnored);
      this.host.post({ type: "projectFiles", requestId, items });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.host.log(`project file search failed: ${messageText}`);
      this.host.post({ type: "projectFiles", requestId, items: [], error: messageText });
    }
  }

  private async sendPrompt(text: string, streamingBehavior?: "steer" | "followUp", references?: string[]): Promise<void> {
    if (this.activeDelegation && this.displayedSession === this.activeDelegation.child) return;
    let trimmed = text.trim();

    // Validate untrusted webview paths and fold them into the prompt as plain
    // text; the model reads files itself via the `read` tool.
    if (references?.length) {
      try {
        const validated = await this.projectFiles.validate(this.runtime.cwd, references);
        if (validated.paths.length > 0) {
          const lines = validated.paths.map((path) => {
            const flags: string[] = [];
            if (validated.ignored.includes(path)) flags.push("gitignored");
            if (validated.sensitive.includes(path)) flags.push("potentially sensitive");
            return `@${path}${flags.length ? ` (${flags.join(", ")})` : ""}`;
          });
          trimmed = `${trimmed ? `${trimmed}\n\n` : ""}Referenced project files (relative to the workspace root; use the read tool to inspect them):\n${lines.join("\n")}`;
        }
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        this.host.log(`file reference rejected: ${messageText}`);
        this.emit(this.runtime.session, { kind: "error", text: messageText });
        return;
      }
    }
    if (!trimmed) return;

    // Built-in commands are host UI concerns; everything else (prompt
    // templates, extension commands, /skill:*) is expanded by the session.
    try {
      if (await runBuiltinCommand(this.runtime, trimmed, this.builtinActions())) return;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.host.log(`command failed: ${messageText}`);
      this.emit(this.runtime.session, { kind: "error", text: messageText });
      return;
    }

    const streaming = this.runtime.session.isStreaming;
    const mode = streaming ? (streamingBehavior ?? "followUp") : undefined;
    this.emit(this.runtime.session, { kind: "user_message", text: trimmed, mode });
    try {
      await this.runtime.session.prompt(trimmed, {
        streamingBehavior: mode,
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      this.host.log(`prompt failed: ${messageText}`);
      this.emit(this.runtime.session, { kind: "error", text: messageText });
    } finally {
      await this.postState();
    }
  }

  /** Sign in to a provider; on success re-check availability and refresh the UI. */
  async login(): Promise<boolean> {
    const changed = await loginFlow(this.runtime, (message) => this.host.log(message));
    if (changed) await this.postState();
    return changed;
  }

  async logout(): Promise<boolean> {
    const changed = await logoutFlow(this.runtime, (message) => this.host.log(message));
    if (changed) await this.postState();
    return changed;
  }

  private builtinActions() {
    return {
      newSession: async () => {
        if (this.guardStreaming()) return;
        await this.runtime.newSession();
        await this.attach();
      },
      resumeSession: async () => {
        if (this.guardStreaming()) return;
        const items = await this.listSessions();
        const picked = await vscode.window.showQuickPick(
          items.map((item) => ({ label: item.title, description: item.timestamp, file: item.file })),
          { title: "Pi Agent Chat: resume session" },
        );
        if (!picked) return;
        await this.runtime.switchSession(picked.file);
        await this.attach();
      },
      pickModel: async (argument: string) => {
        if (argument.includes("/")) {
          const [providerId, ...rest] = argument.split("/");
          await this.runtime.setModel(providerId!, rest.join("/"));
          return;
        }
        await this.pickModel();
      },
      pickThinkingLevel: async () => this.pickThinkingLevel(),
      login: async () => {
        await this.login();
      },
      logout: async () => {
        await this.logout();
      },
      reload: async () => {
        await this.runtime.reloadResources();
        this.postCommands();
        this.postResources();
      },
      reattach: async () => this.attach(),
      status: (text: string) => this.emit(this.runtime.session, { kind: "status", text }),
      setInput: (text: string) => this.host.post({ type: "setInput", text }),
      refresh: () => void this.postState(),
    };
  }

  private async pickModel(): Promise<void> {
    const models = await this.runtime.getAvailableModels();
    if (models.length === 0) {
      const signIn = "Sign in";
      const answer = await vscode.window.showWarningMessage(
        "Pi Agent Chat: no authenticated model found.",
        signIn,
      );
      if (answer === signIn) await this.login();
      return;
    }
    const current = this.runtime.session.model as { id?: string; provider?: string } | undefined;
    const items = models.map((model) => {
      const isCurrent = model.id === current?.id && model.provider === current?.provider;
      return {
        label: `${isCurrent ? "$(check) " : ""}${model.id}`,
        description: isCurrent ? `${model.provider} — current` : model.provider,
        picked: isCurrent,
        model,
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: "Pi Agent Chat: select model",
      matchOnDescription: true,
    });
    if (!picked) return;
    await this.runtime.setModel(picked.model.provider, picked.model.id);
    await this.postState();
  }

  private async pickThinkingLevel(): Promise<void> {
    const session = this.runtime.session;
    const levels = session.getAvailableThinkingLevels();
    if (levels.length <= 1) {
      vscode.window.showInformationMessage("Pi Agent Chat: the current model has no selectable thinking levels.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      levels.map((level) => {
        const isCurrent = level === session.thinkingLevel;
        return {
          label: `${isCurrent ? "$(check) " : ""}${level}`,
          description: isCurrent ? "current" : undefined,
          level,
        };
      }),
      { title: "Pi Agent Chat: select thinking level" },
    );
    if (!picked) return;
    session.setThinkingLevel(picked.level);
    await this.postState();
  }

  private async listSessions(): Promise<SessionListItem[]> {
    const sessions = await SessionManager.list(this.runtime.cwd);
    const displayedFile = (this.displayedSession ?? this.runtime.session).sessionFile;
    const run = this.activeDelegation;
    return sessions.map((info) => ({
      file: info.path,
      title: info.name || info.firstMessage || "(empty session)",
      timestamp: info.modified?.toISOString(),
      current: Boolean(displayedFile) && info.path === displayedFile,
      delegationRole: run && info.path === run.parent.sessionFile
        ? "parent"
        : run && info.path === run.child.sessionFile
          ? "child"
          : undefined,
    }));
  }

  private async refreshSessions(): Promise<void> {
    this.host.post({ type: "sessions", items: await this.listSessions() });
  }

  /** Delete a session file after confirmation; active task-line sessions cannot be deleted. */
  private async deleteSession(file: string): Promise<void> {
    const run = this.activeDelegation;
    if (file === this.runtime.session.sessionFile || file === run?.child.sessionFile) {
      vscode.window.showWarningMessage(
        vscode.env.language.toLowerCase().startsWith("zh")
          ? "无法删除当前正在使用的 session，请先切换到其它 session。"
          : "Cannot delete the session that is currently open. Switch to another session first.",
      );
      return;
    }
    const zh = vscode.env.language.toLowerCase().startsWith("zh");
    const confirmLabel = zh ? "删除" : "Delete";
    const answer = await vscode.window.showWarningMessage(
      zh ? "删除这个 session？文件将被移除，不可恢复。" : "Delete this session? The file will be removed permanently.",
      { modal: true, detail: file },
      confirmLabel,
    );
    if (answer !== confirmLabel) return;
    await vscode.workspace.fs.delete(vscode.Uri.file(file));
    this.host.post({ type: "sessions", items: await this.listSessions() });
  }

  dispose(): void {
    this.disposed = true;
    this.statePostVersion++;
    this.runtime.subagents.setObserver(undefined);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

/**
 * Build the CLI-style startup listing from the session's resource loader,
 * mirroring `interactive-mode`'s [Context] / [Skills] / [Prompts] /
 * [Extensions] / [Themes] sections. Empty sections are omitted.
 */
export function collectResourceSections(runtime: PiRuntime): ResourceSection[] {
  const loader = runtime.session.resourceLoader;
  const sections: ResourceSection[] = [];

  const systemPromptSource = loader.getSystemPromptSource();
  const contextFiles = [
    ...(systemPromptSource ? [systemPromptSource] : []),
    ...loader.getAppendSystemPromptSources(),
    ...loader.getAgentsFiles().agentsFiles,
  ];
  if (contextFiles.length > 0) {
    sections.push({
      name: "Context",
      items: contextFiles.map((file) => basename(file.path)),
      details: contextFiles.map((file) => file.path),
    });
  }

  const skills = loader.getSkills().skills;
  if (skills.length > 0) {
    sections.push({
      name: "Skills",
      items: skills.map((skill) => skill.name).sort((a, b) => a.localeCompare(b)),
      details: skills.map((skill) => skill.filePath),
    });
  }

  const prompts = loader.getPrompts().prompts;
  if (prompts.length > 0) {
    sections.push({
      name: "Prompts",
      items: prompts.map((prompt) => `/${prompt.name}`).sort((a, b) => a.localeCompare(b)),
      details: prompts.map((prompt) => prompt.filePath),
    });
  }

  const { extensions: allExtensions, errors: extensionErrors } = runtime.session.resourceLoader.getExtensions();
  const extensions = allExtensions.filter((extension) => !extension.hidden);
  if (extensions.length > 0 || extensionErrors.length > 0) {
    sections.push({
      name: "Extensions",
      items: [
        ...extensions.map((extension) => basename(extension.path)).sort((a, b) => a.localeCompare(b)),
        ...extensionErrors.map((failure) => `${basename(failure.path)} (load failed)`),
      ],
      details: [
        ...extensions.map((extension) => extension.path),
        ...extensionErrors.map((failure) => `${failure.path}: ${String(failure.error)}`),
      ],
    });
  }

  const themes = loader.getThemes().themes.filter((theme) => (theme as { sourcePath?: string }).sourcePath);
  if (themes.length > 0) {
    sections.push({
      name: "Themes",
      items: themes
        .map((theme) => (theme as { name?: string; sourcePath?: string }).name ?? basename((theme as { sourcePath?: string }).sourcePath ?? ""))
        .sort((a, b) => a.localeCompare(b)),
      details: themes.map((theme) => (theme as { sourcePath?: string }).sourcePath ?? ""),
    });
  }

  return sections;
}

/** Extract plain text from an `AgentToolResult`-shaped value. */
function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/**
 * Convert a persisted transcript into the same `ChatEvent` shapes the live
 * stream produces, so the webview has a single rendering path.
 */
export function buildHistoryEvents(messages: readonly unknown[], cwd: string): ChatEvent[] {
  const events: ChatEvent[] = [];
  const toolArgs = new Map<string, unknown>();

  for (const raw of messages) {
    const message = raw as {
      role?: string;
      content?: unknown;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
      stopReason?: string;
      errorMessage?: string;
      details?: { patch?: string; path?: string };
    };

    if (message.role === "user") {
      const text = contentText(message.content);
      if (text.trim()) events.push({ kind: "user_message", text });
      continue;
    }

    if (message.role === "assistant") {
      const parts = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
      const thinking = parts
        .filter((part) => part.type === "thinking" && typeof part.thinking === "string")
        .map((part) => part.thinking as string)
        .join("\n\n");
      if (thinking.trim()) events.push({ kind: "thinking_message", text: thinking });
      const text = parts
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
      if (text.trim()) events.push({ kind: "assistant_message", text });
      for (const part of parts) {
        if (part.type === "toolCall" && typeof part.id === "string") toolArgs.set(part.id, part.arguments);
      }
      if (message.stopReason === "error" && message.errorMessage) {
        events.push({ kind: "error", text: message.errorMessage });
      }
      continue;
    }

    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const args = toolArgs.get(message.toolCallId);
      events.push({
        kind: "tool_end",
        id: message.toolCallId,
        name: message.toolName ?? "tool",
        isError: Boolean(message.isError),
        text: contentText(message.content),
        args,
        patch: typeof message.details?.patch === "string" ? message.details.patch : undefined,
        path: toolFilePath(args, cwd),
      });
    }
  }

  return events;
}

/** The edit/write tools name their target file through the `path` argument. */
function toolFilePath(args: unknown, cwd: string): string | undefined {
  const path = (args as { path?: unknown } | undefined)?.path;
  if (typeof path !== "string" || !path.trim()) return undefined;
  return isAbsolute(path) ? path : resolvePath(cwd, path);
}

/** Message content is either a plain string or a content-part array. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => (part as { type?: string })?.type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("\n");
}
