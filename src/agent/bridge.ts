import { isAbsolute, basename, relative as relativePath, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import * as vscode from "vscode";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ChatEvent, ChatState, ChatStats, HostMessage, ResourceItem, ResourceScope, ResourceSection, SessionListItem, WebviewMessage } from "../shared/protocol.js";
import { loginFlow, logoutFlow } from "./auth.js";
import { collectSlashCommands, formatHelp, runBuiltinCommand } from "./commands.js";
import { describe } from "./errors.js";
import { t, tf } from "./i18n.js";
import { editEntryLabel, forkFromEntry, navigateSessionTree, switchToEntry } from "./session-tree.js";
import { openSettingsMenu } from "./settings-menu.js";
import type { OriginalContentProvider } from "./diff-view.js";
import { openEditDiff } from "./diff-view.js";
import { ProjectFileIndex } from "./project-files.js";
import { buildModelCatalog, manageScopedModels, pickModel } from "./model-picker.js";
import type { PiRuntime } from "./runtime.js";
import { EMPTY_SKILL_INDEX, buildSkillIndex, collapseSkillInvocation, invokedSkill, matchSkill, readSkillInvocation, type SkillIndex } from "./skills.js";
import type { SubagentObserver, SubagentOutcome, SubagentRun } from "./subagent.js";

export interface BridgeHost {
  post(message: HostMessage): void;
  log(message: string): void;
}

interface CompactionQueuedPrompt {
  text: string;
  mode: "steer" | "followUp";
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
  /** Read-only preview of another session while a run is in progress. */
  private preview?: { file: string; title: string; events: ChatEvent[] };
  /** Whether the webview's sessions page is on screen. */
  private sessionsVisible = false;
  /** Trailing debounce so bursts of session events cause one file scan. */
  private sessionsRefreshTimer?: ReturnType<typeof setTimeout>;
  /** Only the newest async state snapshot may reach the webview. */
  private statePostVersion = 0;
  /** Cancels the availability probe of a superseded (or disposed) state post. */
  private availabilityProbe?: AbortController;
  /** Replay buffers keep parent and child transcripts intact while viewing either. */
  private readonly histories = new Map<string, ChatEvent[]>();
  /** Application-level queue used while the SDK is compacting. */
  private readonly compactionQueues = new Map<string, CompactionQueuedPrompt[]>();
  /** Arguments of in-flight tool calls, used to resolve the edited file path. */
  private readonly pendingToolArgs = new Map<string, unknown>();
  /** Absolute skill paths, used to label tool calls that load or run a skill. */
  private skillIndex: SkillIndex = EMPTY_SKILL_INDEX;
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
    const started = Date.now();
    this.unsubscribe?.();
    const session = this.runtime.session;
    this.displayedSession = session;
    this.preview = undefined;
    this.histories.clear();
    this.compactionQueues.clear();
    this.skillIndex = buildSkillIndex(session);
    const events = this.buildHistory(session);
    this.histories.set(session.sessionId, events);
    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(session, event));
    const built = Date.now();
    // Get the transcript on screen first: binding extensions and collecting
    // resources are the slow parts and the webview needs none of them to
    // render history. Until this arrives the webview shows a loading row.
    this.postHistory();
    const posted = Date.now();
    await this.runtime.bindExtensions();
    const bound = Date.now();
    this.postCommands();
    this.postResources();
    await this.postState();
    this.host.log(
      `session attach: ${events.length} events, build ${built - started}ms, post ${posted - built}ms, ` +
        `bind ${bound - posted}ms, resources+state ${Date.now() - bound}ms`,
    );
    // Only the sessions page needs this; never make the transcript wait for it.
    this.refreshSessions();
  }

  /**
   * The CLI-style startup listing ([Context] / [Skills] / [Prompts] /
   * [Extensions] / [Themes]), pinned above the transcript in the webview.
   */
  postResources(): void {
    try {
      // Extensions and skills are (re)loaded by now, so refresh the matcher too.
      this.skillIndex = buildSkillIndex(this.runtime.session);
      this.host.post({ type: "resources", sections: collectResourceSections(this.runtime) });
    } catch (error) {
      this.host.log(`failed to collect resources: ${describe(error)}`);
    }
  }

  /** Push the `/` autocomplete catalogue (built-ins, prompts, extensions, skills). */
  postCommands(): void {
    try {
      this.host.post({ type: "commands", items: collectSlashCommands(this.runtime.session) });
    } catch (error) {
      this.host.log(`failed to collect slash commands: ${describe(error)}`);
    }
  }

  /**
   * Authenticated models for the composer's model picker. Requested on demand
   * by the webview, and pushed again whenever credentials or the frequently
   * used / default markers change.
   */
  async postModels(): Promise<void> {
    try {
      this.host.post({ type: "models", catalog: await buildModelCatalog(this.runtime) });
    } catch (error) {
      this.host.log(`failed to collect models: ${describe(error)}`);
    }
  }

  /** Replay the persisted transcript so a resumed session is not shown empty. */
  postHistory(): void {
    const session = this.displayedSession ?? this.runtime.session;
    // SYSTEM.md replaces the SDK's default prompt, including the absolute paths
    // that teach the model where Pi's bundled docs and examples live.
    const systemPromptOverridden = Boolean(session.resourceLoader.getSystemPromptSource());
    if (this.preview) {
      this.host.post({ type: "history", events: [...this.preview.events], systemPromptOverridden });
      this.postEntryIds();
      return;
    }
    const events = this.histories.get(session.sessionId) ?? this.buildHistory(session);
    this.histories.set(session.sessionId, events);
    // A replay of a still-streaming session must not close its open work
    // block in the webview; live events keep appending to the same card.
    this.host.post({ type: "history", events: [...events], live: session.isStreaming, systemPromptOverridden });
    // Every replay rebuilds the bubbles, so their entry bindings must follow.
    this.postEntryIds();
  }

  /**
   * Tell the webview which session entry each user bubble belongs to, so the
   * per-bubble actions (switch / fork / label) can address it.
   *
   * Only the live runtime transcript is actionable: a read-only preview or a
   * subagent's transcript gets an empty list, which hides the buttons.
   */
  postEntryIds(): void {
    const session = this.runtime.session;
    const actionable = !this.preview && !this.activeDelegation && (this.displayedSession ?? session) === session;
    if (!actionable) {
      this.host.post({ type: "entryIds", ids: [], labels: [] });
      return;
    }
    try {
      const ids = userEntryIds(session.sessionManager.getBranch());
      const labels = ids.map((id) => session.sessionManager.getLabel(id));
      this.host.post({ type: "entryIds", ids, labels });
    } catch (error) {
      this.host.log(`failed to collect entry ids: ${describe(error)}`);
    }
  }

  async postState(): Promise<void> {
    // getAvailableModels() is asynchronous. Without a version check, a state
    // snapshot started while the child is displayed can arrive after the child
    // finishes and overwrite the authoritative parent state. The probe is also
    // cancelled outright so a superseded call stops touching providers.
    const postVersion = ++this.statePostVersion;
    this.availabilityProbe?.abort();
    const probe = new AbortController();
    this.availabilityProbe = probe;
    const session = this.displayedSession ?? this.runtime.session;
    const model = session.model as { id?: string; provider?: string } | undefined;
    let needsAuth = false;
    try {
      needsAuth = (await this.runtime.getAvailableModels(probe.signal)).length === 0;
    } catch {
      // Availability check failing (or being cancelled) must not block the chat UI.
    }
    if (postVersion !== this.statePostVersion || this.disposed) return;
    const preview = this.preview;
    const state: ChatState = {
      ready: true,
      cwd: this.runtime.cwd,
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      sessionName: this.sessionDisplayName(session),
      modelId: model?.id,
      providerId: model?.provider,
      thinkingLevel: session.thinkingLevel,
      // The composer picker offers exactly these; a model with one fixed level
      // hides the selector instead of opening a dead end.
      thinkingLevels: session.getAvailableThinkingLevels(),
      // In preview the live run keeps going, but the transcript on screen is
      // static history: no stop button, no working indicator.
      isStreaming: preview ? false : session.isStreaming,
      isCompacting: preview ? false : session.isCompacting,
      needsAuth,
      messageCount: session.messages.length,
      delegation: preview ? undefined : this.delegationState(session),
      preview: preview ? { file: preview.file, title: preview.title } : undefined,
      inputDisabled: Boolean(preview) || Boolean(this.activeDelegation && session === this.activeDelegation.child),
      stats: this.collectStats(session),
    };
    this.host.post({ type: "state", state });
  }

  /** Header title: user-set name, else the first user message, else empty. */
  private sessionDisplayName(session: AgentSession): string | undefined {
    const name = session.sessionManager.getSessionName();
    if (name) return name;
    for (const raw of session.messages as Array<{ role?: string; content?: unknown }>) {
      if (raw.role !== "user") continue;
      const text = collapseSkillInvocation(contentText(raw.content)).trim();
      if (text) return text.split("\n")[0];
    }
    return undefined;
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

  /** Full active-branch replay with the current skill index applied to tool cards. */
  private buildHistory(session: AgentSession): ChatEvent[] {
    return buildHistoryEntryEvents(session.sessionManager.getBranch(), this.runtime.cwd, this.skillIndex);
  }

  private emit(session: AgentSession, event: ChatEvent): void {
    if (this.disposed) return;
    const history = this.histories.get(session.sessionId) ?? this.buildHistory(session);
    history.push(event);
    this.histories.set(session.sessionId, history);
    if (!this.preview && (this.displayedSession ?? this.runtime.session) === session) {
      this.host.post({ type: "event", event });
    }
  }

  /** Merge the host-owned compaction queue with the SDK's normal queues. */
  private emitCombinedQueueUpdate(
    session: AgentSession,
    steering: readonly string[] = session.getSteeringMessages(),
    followUp: readonly string[] = session.getFollowUpMessages(),
  ): void {
    const local = this.compactionQueues.get(session.sessionId) ?? [];
    this.emit(session, {
      kind: "queue_update",
      steering: [
        ...steering.map(collapseSkillInvocation),
        ...local.filter((item) => item.mode === "steer").map((item) => item.text),
      ],
      followUp: [
        ...followUp.map(collapseSkillInvocation),
        ...local.filter((item) => item.mode === "followUp").map((item) => item.text),
      ],
    });
  }

  private queueDuringCompaction(session: AgentSession, text: string, mode: "steer" | "followUp"): void {
    const queue = this.compactionQueues.get(session.sessionId) ?? [];
    queue.push({ text, mode });
    this.compactionQueues.set(session.sessionId, queue);
    this.emit(session, { kind: "user_message", text, mode, skill: invokedSkill(this.skillIndex, text) });
    this.emitCombinedQueueUpdate(session);
  }

  /**
   * Move compaction-time submissions into the SDK queue. Manual compaction is
   * idle afterwards, so its first queued message starts a run; automatic
   * compaction stays inside the existing run and accepts every item directly.
   */
  private async flushCompactionQueue(session: AgentSession, willRetry: boolean): Promise<void> {
    const sessionId = session.sessionId;
    const queued = [...(this.compactionQueues.get(sessionId) ?? [])];
    if (queued.length === 0) return;

    const restore = (items: CompactionQueuedPrompt[], error: unknown) => {
      this.compactionQueues.set(sessionId, items);
      session.clearQueue();
      this.reportError(session, "failed to send message queued during compaction", error);
      void this.postState();
    };

    // Auto-compaction is part of an active run (including overflow retry).
    if (willRetry || session.isStreaming) {
      try {
        for (const item of queued) {
          if (item.mode === "followUp") await session.followUp(item.text);
          else await session.steer(item.text);
        }
        this.compactionQueues.delete(sessionId);
        this.emitCombinedQueueUpdate(session);
      } catch (error) {
        restore(queued, error);
      }
      return;
    }

    // Manual compaction has no active agent loop. Start the first item as a
    // normal prompt, then transfer the rest once preflight has succeeded.
    const [first, ...rest] = queued;
    if (!first) return;
    let resolvePreflight!: (success: boolean) => void;
    const preflight = new Promise<boolean>((resolve) => {
      resolvePreflight = resolve;
    });
    let started = false;
    let failed = false;
    const promptPromise = session
      .prompt(first.text, { preflightResult: resolvePreflight })
      .catch((error) => {
        failed = true;
        restore(started ? rest : queued, error);
      });

    const preflightSucceeded = await preflight;
    started = preflightSucceeded;
    if (!preflightSucceeded) {
      await promptPromise;
      return;
    }

    if (rest.length > 0) this.compactionQueues.set(sessionId, rest);
    else this.compactionQueues.delete(sessionId);
    this.emitCombinedQueueUpdate(session);
    try {
      for (const item of rest) {
        if (failed) return;
        if (item.mode === "followUp") await session.followUp(item.text);
        else await session.steer(item.text);
      }
      if (!failed) {
        this.compactionQueues.delete(sessionId);
        this.emitCombinedQueueUpdate(session);
      }
    } catch (error) {
      failed = true;
      restore(rest, error);
    }
    void promptPromise.finally(() => this.postState());
  }

  private isExtensionCommand(session: AgentSession, text: string): boolean {
    if (!text.startsWith("/")) return false;
    const separator = text.indexOf(" ");
    const name = separator === -1 ? text.slice(1) : text.slice(1, separator);
    return session.extensionRunner.getRegisteredCommands().some((command) => command.invocationName === name);
  }

  private onSessionEvent(session: AgentSession, event: AgentSessionEvent): void {
    const toolKey = (id: string) => `${session.sessionId}:${id}`;
    switch (event.type) {
      case "agent_start":
        this.emit(session, { kind: "agent_start" });
        void this.postState();
        // Push the in-memory merged entry (see listSessions) to an open list
        // as soon as the run starts, before the session is flushed to disk.
        this.refreshSessions();
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
        // A preview left open after the run finishes would trap the user in a
        // read-only view; the previewed session can now be resumed for real.
        if (this.preview && !this.activeDelegation && session === this.runtime.session && !session.isStreaming) {
          const file = this.preview.file;
          void (async () => {
            await this.runtime.switchSession(file);
            await this.attach();
          })();
          break;
        }
        void this.postState();
        this.postEntryIds();
        this.refreshSessions();
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
        // The SDK defers writing a brand-new session to disk until the first
        // assistant message completes; refresh here so the sessions list can
        // show the new session before the whole run settles.
        if (event.message.role === "assistant") this.refreshSessions();
        // Provider failures are encoded on the completed assistant message.
        // AgentState.errorMessage is only updated at turn_end, so it is not
        // available yet when message_end is delivered.
        if (event.message.role === "assistant" && event.message.stopReason === "error" && event.message.errorMessage) {
          this.emit(session, { kind: "error", text: event.message.errorMessage });
        }
        break;
      case "tool_execution_start":
        this.pendingToolArgs.set(toolKey(event.toolCallId), event.args);
        this.emit(session, {
          kind: "tool_start",
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
          skill: matchSkill(this.skillIndex, event.toolName, event.args, this.runtime.cwd),
        });
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
          skill: matchSkill(this.skillIndex, event.toolName, args, this.runtime.cwd),
        });
        break;
      }
      case "queue_update":
        // The SDK queues `/skill:*` prompts after expanding them to a full
        // `<skill>` block. Keep queue reconciliation on the short command form
        // and include submissions held by the host during compaction.
        this.emitCombinedQueueUpdate(session, event.steering, event.followUp);
        break;
      case "compaction_start":
        // `/compact` already emits a localized command-scoped start notice.
        // Unlike automatic compaction, the manual API does not emit
        // agent_settled, so grouping its lifecycle notice in a work block would
        // leave that block permanently running. Completion is shown by the
        // persistent compaction boundary emitted from compaction_end.
        if (event.reason !== "manual") {
          this.emit(session, { kind: "status", text: `compacting context (${event.reason})...` });
        }
        void this.postState();
        break;
      case "compaction_end":
        if (event.reason !== "manual") {
          this.emit(session, { kind: "status", text: event.errorMessage ? `compaction failed: ${event.errorMessage}` : "compaction done" });
        }
        if (event.result) {
          this.emit(session, {
            kind: "compaction_boundary",
            summary: event.result.summary,
            tokensBefore: event.result.tokensBefore,
            estimatedTokensAfter: event.result.estimatedTokensAfter,
          });
        }
        void this.postState();
        void this.flushCompactionQueue(session, event.willRetry);
        break;
      case "auto_retry_start":
        this.emit(session, { kind: "status", text: `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}` });
        break;
      case "auto_retry_end":
        this.emit(session, { kind: "status", text: event.success ? "retry succeeded" : `retry failed: ${event.finalError ?? "unknown"}` });
        break;
      case "session_info_changed":
        void this.postState();
        break;
      default:
        break;
    }
  }

  onSubagentStarted(run: SubagentRun): void {
    this.activeDelegation = run;
    this.histories.set(run.child.sessionId, [{ kind: "user_message", text: run.task }]);
    this.displayedSession = run.child;
    if (!this.preview) this.postHistory();
    void this.postState();
    this.refreshSessions();
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
    if (!this.preview) this.postHistory();
    void this.postState();
    this.refreshSessions();
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
    this.preview = undefined;
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
      case "dequeue": {
        const session = this.runtime.session;
        const sdkQueued = [...session.getSteeringMessages(), ...session.getFollowUpMessages()].map(collapseSkillInvocation);
        const compactingQueued = this.compactionQueues.get(session.sessionId) ?? [];
        const queued = [...sdkQueued, ...compactingQueued.map((item) => item.text)];
        if (queued.length === 0) break;
        // Tell the webview first so pending bubbles are removed before the
        // queue_update from clearQueue() arrives (which would otherwise
        // treat them as consumed and pin them into the transcript).
        this.host.post({ type: "dequeued", texts: queued });
        this.compactionQueues.delete(session.sessionId);
        session.clearQueue();
        break;
      }
      case "newSession":
        if (this.guardStreaming()) break;
        await this.runtime.newSession();
        await this.attach();
        break;
      case "sessionsVisible":
        this.sessionsVisible = message.visible;
        if (message.visible) {
          await this.pushSessions();
        } else if (this.sessionsRefreshTimer) {
          clearTimeout(this.sessionsRefreshTimer);
          this.sessionsRefreshTimer = undefined;
        }
        break;
      case "listCommands":
        this.postCommands();
        break;
      case "resumeSession":
        if (this.guardStreaming()) break;
        await this.runtime.switchSession(message.file);
        await this.attach();
        break;
      case "previewSession":
        await this.previewSession(message.file);
        break;
      case "closePreview":
        this.closePreview();
        break;
      case "showDelegationSession":
        this.showDelegationSession(message.target);
        break;
      case "deleteSession":
        await this.deleteSession(message.file);
        break;
      case "renameSession":
        await this.renameSession(message.file);
        break;
      case "openSessionTree":
        if (this.guardStreaming()) break;
        await navigateSessionTree(this.runtime, this.builtinActions());
        await this.attach();
        break;
      case "entryAction":
        await this.runEntryAction(message.action, message.entryId);
        break;
      case "listModels":
        await this.postModels();
        break;
      case "setModel":
        await this.setModel(message.provider, message.modelId);
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
      case "setThinkingLevel":
        this.setThinkingLevel(message.level);
        await this.postState();
        break;
      case "openSettings": {
        const status = (text: string) => this.emitCommandStatus(text);
        await openSettingsMenu(this.runtime, {
          login: async () => {
            await this.login();
          },
          status,
          help: () => status(formatHelp()),
          manageScopedModels: async () => {
            await manageScopedModels(this.runtime, this.modelPickerUi());
            await this.postModels();
          },
          commandsChanged: () => this.postCommands(),
        });
        await this.postState();
        break;
      }
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
    if (this.preview) return; // preview shows a static transcript; nothing to stop
    const displayed = this.displayedSession ?? this.runtime.session;
    if (displayed.isCompacting) {
      displayed.abortCompaction();
      return;
    }
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
    if (!this.runtime.session.isStreaming && !this.runtime.session.isCompacting) return false;
    vscode.window.showWarningMessage(t("singleSessionGuard"));
    return true;
  }

  /**
   * Apply one session-tree operation triggered from a transcript bubble.
   *
   * `switch` and `fork` change what the transcript must show, so they replay
   * through `attach()`. A label only annotates an entry, so it just refreshes
   * the id/label mapping.
   */
  private async runEntryAction(action: "switch" | "fork" | "label", entryId: string): Promise<void> {
    if (this.preview || this.activeDelegation) return;
    if (action !== "label" && this.guardStreaming()) return;
    const ui = this.builtinActions();
    try {
      if (action === "switch") await switchToEntry(this.runtime, entryId, ui);
      else if (action === "fork") await forkFromEntry(this.runtime, entryId, ui);
      else await editEntryLabel(this.runtime, entryId, ui);
    } catch (error) {
      this.reportError(this.runtime.session, `${action} failed`, error);
      return;
    }
    if (action === "label") this.postEntryIds();
    else await this.attach();
  }

  /**
   * Open another session's transcript read-only, without touching the runtime
   * session: the JSONL file is replayed into events. Used while a run is in
   * progress, when switching the active session is not allowed.
   */
  private async previewSession(file: string): Promise<void> {
    try {
      const manager = SessionManager.open(file);
      const events = buildHistoryEntryEvents(manager.getBranch(), this.runtime.cwd, this.skillIndex);
      const firstUser = events.find((event) => event.kind === "user_message") as { text?: string } | undefined;
      this.preview = { file, title: (firstUser?.text ?? "").split("\n")[0] ?? "", events };
      this.postHistory();
      await this.postState();
      this.refreshSessions();
    } catch (error) {
      this.reportError(this.runtime.session, "session preview failed", error);
    }
  }

  /** Return from a read-only preview to the live transcript. */
  private closePreview(): void {
    if (!this.preview) return;
    this.preview = undefined;
    this.postHistory();
    void this.postState();
    this.refreshSessions();
  }

  /** Answer a webview @ picker query; errors are reported inline, never thrown. */
  private async listProjectFiles(requestId: number, query: string, includeIgnored: boolean): Promise<void> {
    try {
      const items = await this.projectFiles.search(this.runtime.cwd, query, includeIgnored);
      this.host.post({ type: "projectFiles", requestId, items });
    } catch (error) {
      const messageText = describe(error);
      this.host.log(`project file search failed: ${messageText}`);
      this.host.post({ type: "projectFiles", requestId, items: [], error: messageText });
    }
  }

  /** Log a failure and surface it as an error notice in the transcript. */
  private reportError(session: AgentSession, context: string, error: unknown, scope?: "command"): void {
    const messageText = describe(error);
    this.host.log(`${context}: ${messageText}`);
    this.emit(session, { kind: "error", text: messageText, scope });
  }

  private async sendPrompt(text: string, streamingBehavior?: "steer" | "followUp", references?: string[]): Promise<void> {
    if (this.preview) return;
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
          trimmed = `${trimmed ? `${trimmed}\n\n` : ""}${tf("referencedFilesHeader", lines.join("\n"))}`;
        }
      } catch (error) {
        this.reportError(this.runtime.session, "file reference rejected", error);
        return;
      }
    }
    if (!trimmed) return;

    // Built-in commands are host UI concerns; everything else (prompt
    // templates, extension commands, /skill:*) is expanded by the session.
    try {
      if (await runBuiltinCommand(this.runtime, trimmed, this.builtinActions())) return;
    } catch (error) {
      this.reportError(this.runtime.session, "command failed", error, "command");
      return;
    }

    const session = this.runtime.session;
    const extensionCommand = this.isExtensionCommand(session, trimmed);
    if (session.isCompacting && !extensionCommand) {
      this.queueDuringCompaction(session, trimmed, streamingBehavior ?? "followUp");
      return;
    }

    const streaming = session.isStreaming && !extensionCommand;
    const mode = streaming ? (streamingBehavior ?? "followUp") : undefined;
    // The SDK expands `/skill:<name>` inside prompt(); the text emitted here is
    // still the command form, so the skill is resolved from the command itself.
    this.emit(session, { kind: "user_message", text: trimmed, mode, skill: invokedSkill(this.skillIndex, trimmed) });
    try {
      await session.prompt(trimmed, {
        streamingBehavior: mode,
      });
    } catch (error) {
      this.reportError(this.runtime.session, "prompt failed", error);
    } finally {
      await this.postState();
    }
  }

  /** Sign in to a provider; on success re-check availability and refresh the UI. */
  async login(): Promise<boolean> {
    const changed = await loginFlow(this.runtime, (message) => this.host.log(message));
    if (changed) {
      await this.postModels();
      await this.postState();
    }
    return changed;
  }

  async logout(): Promise<boolean> {
    const changed = await logoutFlow(this.runtime, (message) => this.host.log(message));
    if (changed) {
      await this.postModels();
      await this.postState();
    }
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
          { title: t("resumeSessionTitle") },
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
        // The picker lives in the composer now; `/model` just opens it there.
        this.host.post({ type: "openPicker", picker: "model" });
      },
      manageScopedModels: async () => {
        await manageScopedModels(this.runtime, this.modelPickerUi());
        await this.postModels();
        await this.postState();
      },
      pickThinkingLevel: async () => {
        if (this.runtime.session.getAvailableThinkingLevels().length <= 1) {
          vscode.window.showInformationMessage(t("noThinkingLevels"));
          return;
        }
        this.host.post({ type: "openPicker", picker: "thinking" });
      },
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
      status: (text: string) => this.emit(this.runtime.session, { kind: "status", text, scope: "command" }),
      setInput: (text: string) => this.host.post({ type: "setInput", text }),
      refresh: () => void this.postState(),
    };
  }

  private modelPickerUi() {
    return {
      login: async () => {
        await this.login();
      },
      status: (text: string) => this.emitCommandStatus(text),
    };
  }

  /** One-line command notice in the transcript (picker actions, settings). */
  private emitCommandStatus(text: string): void {
    this.emit(this.runtime.session, { kind: "status", text, scope: "command" });
  }

  /**
   * The full native picker, opened from "other models" in the composer menu.
   * It can also change the frequently used list and the default model, so the
   * quick menu's contents are rebuilt afterwards.
   */
  private async pickModel(): Promise<void> {
    const changed = await pickModel(this.runtime, this.modelPickerUi());
    await this.postModels();
    if (changed) await this.postState();
  }

  private async setModel(provider: string, modelId: string): Promise<void> {
    try {
      await this.runtime.setModel(provider, modelId);
    } catch (error) {
      this.reportError(this.runtime.session, "model switch failed", error, "command");
      return;
    }
    await this.postState();
  }

  /** Apply a level chosen in the webview, ignoring anything the model rejects. */
  private setThinkingLevel(requested: string): void {
    const session = this.runtime.session;
    const level = session.getAvailableThinkingLevels().find((candidate) => candidate === requested);
    if (!level) {
      this.host.log(`ignored unsupported thinking level: ${requested}`);
      return;
    }
    session.setThinkingLevel(level);
  }

  private async listSessions(): Promise<SessionListItem[]> {
    const sessions = await SessionManager.list(this.runtime.cwd);
    const displayedFile = this.preview?.file ?? (this.displayedSession ?? this.runtime.session).sessionFile;
    const runningFile = this.runtime.session.isStreaming || this.runtime.session.isCompacting
      ? this.runtime.session.sessionFile
      : undefined;
    const run = this.activeDelegation;
    const items: SessionListItem[] = sessions.map((info) => ({
      file: info.path,
      // The SDK stores an expanded <skill> block as the first user message.
      // Restore the command form so session lists show `/skill:name ...`
      // instead of the skill XML and its filesystem location.
      title: info.name || collapseSkillInvocation(info.firstMessage) || t("emptySessionTitle"),
      timestamp: info.modified?.toISOString(),
      current: Boolean(displayedFile) && info.path === displayedFile,
      running: Boolean(runningFile) && info.path === runningFile,
      delegationRole: run && info.path === run.parent.sessionFile
        ? "parent"
        : run && info.path === run.child.sessionFile
          ? "child"
          : undefined,
    }));
    // The SDK defers writing a brand-new session to disk until its first
    // assistant message completes, so a session that already has messages may
    // be missing from the scan. Merge it in from memory; once flushed, the
    // disk entry (same file path) takes over seamlessly.
    const live = this.runtime.session;
    if (live.sessionFile && live.messages.length > 0 && !items.some((item) => item.file === live.sessionFile)) {
      items.unshift({
        file: live.sessionFile,
        title: this.sessionDisplayName(live) ?? t("emptySessionTitle"),
        timestamp: new Date().toISOString(),
        current: live.sessionFile === displayedFile,
        running: live.isStreaming || live.isCompacting,
        delegationRole: undefined,
      });
    }
    return items;
  }

  /**
   * Scanning session files costs O(total JSONL size), so it only happens
   * while the sessions page is visible, and bursts of triggers (agent events
   * arrive in clusters) coalesce into a single delayed scan.
   */
  private refreshSessions(): void {
    if (!this.sessionsVisible || this.disposed) return;
    if (this.sessionsRefreshTimer) return;
    this.sessionsRefreshTimer = setTimeout(() => {
      this.sessionsRefreshTimer = undefined;
      void this.pushSessions();
    }, 300);
  }

  private async pushSessions(): Promise<void> {
    if (!this.sessionsVisible || this.disposed) return;
    this.host.post({ type: "sessions", items: await this.listSessions() });
  }

  /** Delete a session file after confirmation; active task-line sessions cannot be deleted. */
  private async deleteSession(file: string): Promise<void> {
    const run = this.activeDelegation;
    if (file === this.runtime.session.sessionFile || file === run?.child.sessionFile) {
      vscode.window.showWarningMessage(t("deleteActiveSession"));
      return;
    }
    const confirmLabel = t("deleteSessionAction");
    const answer = await vscode.window.showWarningMessage(
      t("deleteSessionConfirm"),
      { modal: true, detail: file },
      confirmLabel,
    );
    if (answer !== confirmLabel) return;
    await vscode.workspace.fs.delete(vscode.Uri.file(file));
    await this.pushSessions();
  }

  /**
   * Rename a session (the `/name` flow, reachable from the sessions list).
   * The active session goes through `setSessionName()` so the SDK emits its
   * change event; any other session file gets a `session_info` entry appended
   * via a short-lived SessionManager. Running delegation children are skipped
   * (their JSONL is being appended to by the run).
   */
  private async renameSession(file: string): Promise<void> {
    const run = this.activeDelegation;
    if (file === run?.child.sessionFile && this.runtime.session !== run.child) {
      vscode.window.showWarningMessage(t("renameRunningSession"));
      return;
    }
    const isActive = file === this.runtime.session.sessionFile;
    const currentName = isActive
      ? this.runtime.session.sessionManager.getSessionName()
      : undefined;
    const value = (
      await vscode.window.showInputBox({ title: t("sessionNameTitle"), value: currentName ?? "" })
    )?.trim();
    if (!value) return;
    try {
      if (isActive) {
        this.runtime.session.setSessionName(value);
      } else {
        SessionManager.open(file).appendSessionInfo(value);
      }
    } catch (error) {
      this.reportError(this.runtime.session, "rename session failed", error);
      return;
    }
    await this.pushSessions();
  }

  dispose(): void {
    this.disposed = true;
    this.statePostVersion++;
    this.availabilityProbe?.abort();
    this.availabilityProbe = undefined;
    if (this.sessionsRefreshTimer) {
      clearTimeout(this.sessionsRefreshTimer);
      this.sessionsRefreshTimer = undefined;
    }
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
  // Every row can be opened in the editor, so it shows just the name (the path
  // stays in the row's tooltip); provenance drives the webview's grouping.
  const entry = (name: string, path: string, sourceInfo?: { origin?: string }) => resourceEntry(name, path, runtime.cwd, sourceInfo);

  const systemPromptSource = loader.getSystemPromptSource();
  const contextFiles = [
    ...(systemPromptSource ? [systemPromptSource] : []),
    ...loader.getAppendSystemPromptSources(),
    ...loader.getAgentsFiles().agentsFiles,
  ];
  if (contextFiles.length > 0) {
    sections.push(sortedSection("Context", contextFiles.map((file) => entry(basename(file.path), file.path))));
  }

  const skills = loader.getSkills().skills;
  if (skills.length > 0) {
    sections.push(sortedSection("Skills", skills.map((skill) => entry(skill.name, skill.filePath, skill.sourceInfo))));
  }

  const prompts = loader.getPrompts().prompts;
  if (prompts.length > 0) {
    sections.push(sortedSection("Prompts", prompts.map((prompt) => entry(`/${prompt.name}`, prompt.filePath, prompt.sourceInfo))));
  }

  const { extensions: allExtensions, errors: extensionErrors } = runtime.session.resourceLoader.getExtensions();
  const extensions = allExtensions.filter((extension) => !extension.hidden);
  if (extensions.length > 0 || extensionErrors.length > 0) {
    sections.push(
      sortedSection("Extensions", [
        ...extensions.map((extension) => entry(basename(extension.path), extension.path, (extension as { sourceInfo?: { origin?: string } }).sourceInfo)),
        // A failed extension has no loaded file to open, so it keeps the error
        // as its row text.
        ...extensionErrors.map((failure) => ({
          label: `${basename(failure.path)} (load failed)`,
          detail: `${failure.path}: ${String(failure.error)}`,
          scope: resourceScope(failure.path, runtime.cwd),
        })),
      ]),
    );
  }

  const themes = loader.getThemes().themes.filter((theme) => (theme as { sourcePath?: string }).sourcePath);
  if (themes.length > 0) {
    sections.push(
      sortedSection(
        "Themes",
        themes.map((theme) => {
          const path = (theme as { sourcePath?: string }).sourcePath ?? "";
          return entry((theme as { name?: string }).name ?? basename(path), path);
        }),
      ),
    );
  }

  return sections;
}

/**
 * Build one listing section, sorted by label. Rows carry their scope so the
 * webview can group them (global first, then project) instead of tagging every
 * row with its origin.
 */
function sortedSection(name: string, items: ResourceItem[]): ResourceSection {
  return { name, items: [...items].sort((a, b) => a.label.localeCompare(b.label)) };
}

/**
 * One listing row: the resource name as the text, the file behind it as the
 * click/tooltip target.
 */
function resourceEntry(name: string, path: string, cwd: string, sourceInfo?: { origin?: string }): ResourceItem {
  if (!path) return { label: name, scope: "other" };
  return { label: name, path, scope: resourceScope(path, cwd, sourceInfo) };
}

/**
 * Where a resource comes from, in the terms the SDK documents
 * (`docs/skills.md`). `sourceInfo.scope` is not usable directly: skills under
 * `~/.agents/skills` or a project `.agents/skills` are neither of the SDK's
 * "user"/"project" roots and end up as "temporary", so classify by location.
 */
function resourceScope(filePath: string, cwd: string, sourceInfo?: { origin?: string }): ResourceScope {
  if (sourceInfo?.origin === "package") return "package";
  const path = resolvePath(filePath);
  if (isInside(path, cwd)) return "project";
  if (isInside(path, homedir())) return "global";
  return "other";
}

function isInside(path: string, root: string): boolean {
  const relative = relativePath(root, path);
  return relative !== "" && !relative.startsWith("..") && !isAbsolute(relative);
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
export function buildHistoryEvents(messages: readonly unknown[], cwd: string, skills: SkillIndex = EMPTY_SKILL_INDEX): ChatEvent[] {
  const events: ChatEvent[] = [];
  const toolArgs = new Map<string, unknown>();
  for (const message of messages) appendHistoryMessage(events, toolArgs, message, cwd, skills);
  return events;
}

/**
 * Replay the complete active branch rather than the compaction-aware model
 * context. Compaction entries become visible boundaries; their retainedTail is
 * deliberately not expanded because those messages already exist earlier in a
 * regular Pi session and would otherwise be duplicated.
 */
export function buildHistoryEntryEvents(entries: readonly SessionEntry[], cwd: string, skills: SkillIndex = EMPTY_SKILL_INDEX): ChatEvent[] {
  const events: ChatEvent[] = [];
  const toolArgs = new Map<string, unknown>();
  for (const entry of entries) {
    if (entry.type === "compaction") {
      events.push({
        kind: "compaction_boundary",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
      });
      continue;
    }
    for (const message of sessionEntryToContextMessages(entry)) {
      appendHistoryMessage(events, toolArgs, message, cwd, skills);
    }
  }
  return events;
}

function appendHistoryMessage(
  events: ChatEvent[],
  toolArgs: Map<string, unknown>,
  raw: unknown,
  cwd: string,
  skills: SkillIndex,
): void {
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
    const { text, skill } = readSkillInvocation(contentText(message.content));
    if (text.trim()) events.push({ kind: "user_message", text, skill });
    return;
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
    return;
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
      skill: matchSkill(skills, message.toolName ?? "", args, cwd),
    });
  }
}

/**
 * Session-entry ids of the user bubbles a transcript shows, in the same order.
 *
 * Mirrors the `role === "user"` branch of `buildHistoryEntryEvents` (same
 * projection and "skip empty text" rule) so the k-th id belongs to the k-th
 * user bubble. Compaction entries are boundaries, not sources of retainedTail
 * bubbles, and must therefore be skipped here too. Exported for diagnostics.
 */
export function userEntryIds(entries: readonly SessionEntry[]): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction") continue;
    for (const message of sessionEntryToContextMessages(entry)) {
      if ((message as { role?: string }).role !== "user") continue;
      const text = collapseSkillInvocation(contentText((message as { content?: unknown }).content));
      if (text.trim()) ids.push(entry.id);
    }
  }
  return ids;
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
