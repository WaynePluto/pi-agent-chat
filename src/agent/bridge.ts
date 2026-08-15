import { isAbsolute, basename, relative as relativePath, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import * as vscode from "vscode";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import { sessionEntryToContextMessages, SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ChatEvent, ChatState, ChatStats, DelegationLane, ExtensionWidget, HostMessage, ResourceItem, ResourceScope, ResourceSection, SessionListItem, WebviewMessage } from "../shared/protocol.js";
import { formatLocalTimestamp } from "../shared/time.js";
import { loginFlow, logoutFlow } from "./auth.js";
import { ActivityTracker, type ResourceActivity } from "./activity.js";
import { affectsSubagentConfig, readSubagentConfig } from "./config.js";
import { collectSlashCommands, formatHelp, runBuiltinCommand } from "./commands.js";
import { describe } from "./errors.js";
import { t, tf } from "./i18n.js";
import { editEntryLabel, forkFromEntry, navigateSessionTree, switchToEntry } from "./session-tree.js";
import { openSettingsMenu } from "./settings-menu.js";
import type { OriginalContentProvider } from "./diff-view.js";
import { openEditDiff } from "./diff-view.js";
import { ProjectFileIndex } from "./project-files.js";
import { buildModelCatalog, manageScopedModels, pickModel } from "./model-picker.js";
import { isModelsConfigPath, repairEmptyModelsConfig } from "./model-config.js";
import type { PiRuntime } from "./runtime.js";
import { EMPTY_PROMPT_INDEX, buildPromptIndex, expandedPrompt, resolveInvocation, type PromptIndex } from "./invocations.js";
import { EMPTY_SKILL_INDEX, buildSkillIndex, collapseSkillInvocation, invokedSkill, matchSkill, readSkillInvocation, type SkillIndex } from "./skills.js";
import { contentText, firstUserLine, sessionTitle } from "./session-title.js";
import { sanitizeToolDetails } from "./tool-details.js";
import type { LaneNotice, LaneState, SubagentObserver, SubagentRun } from "./subagent.js";

export interface BridgeHost {
  post(message: HostMessage): void;
  log(message: string): void;
  /**
   * The session the sidebar is on, so the next window start can return to it.
   *
   * `undefined` means a session with nothing written yet: the JSONL file is
   * created on the first append, so "the user is sitting in a new, empty
   * session" leaves no trace on disk and can only be remembered here.
   */
  rememberSession?(sessionFile: string | undefined): void;
}

interface CompactionQueuedPrompt {
  text: string;
  mode: "steer" | "followUp";
}

/**
 * Lane id used when a subagent is shown by replaying its session file, with no
 * live lane behind it. It only has to be stable within one state snapshot: the
 * banner names the subagent, and the only action offered is going back.
 */
const REPLAYED_LANE_ID = "replayed";

/**
 * How long to wait after a subagent setting changes before acting on it.
 *
 * The Settings editor writes one key per edit, so filling in the section fires
 * several events in a row; without this, changing three values on an empty
 * session would rebuild it three times.
 */
const SUBAGENT_SETTING_DEBOUNCE_MS = 300;

/**
 * How long a manual catalogue refresh may take before it falls back to the
 * cached lists. Same budget the CLI's model selector gives `refresh()`, so a
 * hung endpoint degrades identically in both hosts.
 */
const MODEL_REFRESH_TIMEOUT_MS = 15_000;

/**
 * What the webview is currently showing.
 *
 * One value rather than three independent fields (`displayedSession`,
 * `displayedLaneId`, `preview`), because the legal combinations used to be
 * implicit: a replay and a lane are both "not the live parent transcript" and
 * must never both be set, yet nothing enforced it. Every bug in this area came
 * from updating one of the three and forgetting another — which the compiler
 * had no way to catch. Now each variant carries exactly what its derived values
 * need, and switching views means assigning one value.
 */
type View =
  /** The runtime's own session, live and writable. */
  | { kind: "live" }
  /** A subagent with a live child session: real-time progress, stoppable. */
  | { kind: "lane"; laneId: string; session: AgentSession }
  /**
   * A session replayed read-only from its file.
   *
   * `laneTitle` marks it as a subagent whose child session is gone (the window
   * was reloaded since the run). It still gets the subagent framing: to the
   * user that is what it is, and the generic preview banner would offer "back
   * to the running session" with nothing running.
   */
  | { kind: "replay"; file: string; title: string; events: ChatEvent[]; laneTitle?: string };

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
  /** Last value handed to `host.rememberSession`; absent until the first sync. */
  private remembered?: { file: string | undefined };
  /** What the webview is showing; see `View`. The only source of truth for it. */
  private view: View = { kind: "live" };
  private activeRun?: SubagentRun;
  /**
   * Live child sessions by lane id, for switching the displayed transcript.
   *
   * Accumulates across runs and is only cleared when the displayed session is
   * replaced. A finished lane stays here so that reopening it from its (still
   * visible) tool card lands in the subagent view rather than degrading to a
   * generic read-only replay — which is all that survives a window reload.
   */
  private readonly laneSessions = new Map<string, AgentSession>();
  /** Lane snapshots from every run of this session, newest last. */
  private lanes: LaneState[] = [];
  /** The parent moved on while the user was inside a lane. */
  private parentActivityWhileAway = false;
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
  /**
   * Extension-owned status entries and widgets per session (`ctx.ui.setStatus`,
   * `ctx.ui.setWidget`). Cleared on attach: rebinding extensions re-runs their
   * handlers, which republish whatever is still true, exactly as in the CLI.
   */
  private readonly extensionStatuses = new Map<string, Map<string, string>>();
  private readonly extensionWidgets = new Map<string, Map<string, ExtensionWidget>>();
  /** Application-level queue used while the SDK is compacting. */
  private readonly compactionQueues = new Map<string, CompactionQueuedPrompt[]>();
  /** Arguments of in-flight tool calls, used to resolve the edited file path. */
  private readonly pendingToolArgs = new Map<string, unknown>();
  /** Absolute skill paths, used to label tool calls that load or run a skill. */
  private skillIndex: SkillIndex = EMPTY_SKILL_INDEX;
  /** Loaded prompt templates, used to attribute user messages to a `/command`. */
  private promptIndex: PromptIndex = EMPTY_PROMPT_INDEX;
  private readonly projectFiles: ProjectFileIndex;
  /** What actually took effect in this session, for the resources panel. */
  private readonly activity = new ActivityTracker();
  /** >0 while an extension `/command` handler is running (nestable in theory). */
  private extensionCommandDepth = 0;
  /** Watches saves of the shared `~/.pi/agent/models.json`. */
  private modelsConfigWatcher?: vscode.Disposable;
  private settingsWatcher?: vscode.Disposable;
  /** Pending debounced reaction to a subagent settings change. */
  private subagentConfigTimer?: ReturnType<typeof setTimeout>;
  /** Last reported models.json problem, so the same one is not repeated on every attach. */
  private modelsConfigError?: string;

  constructor(
    private readonly runtime: PiRuntime,
    private readonly host: BridgeHost,
    private readonly diffProvider: OriginalContentProvider,
  ) {
    this.projectFiles = new ProjectFileIndex((message) => host.log(message));
    runtime.subagents.setObserver(this);
    // Must be wired before the first bindExtensions() in attach(): all three
    // sinks below are captured by the contexts created there.
    runtime.setSessionLifecycleSink({
      reattach: () => this.attach(),
      reload: () => this.reloadResources(),
    });
    runtime.setExtensionNoticeSink((session, notice) => {
      this.emit(session, {
        kind: notice.level === "error" ? "error" : "status",
        text: notice.text,
        // During a command the notice is the result the user asked for (top
        // level, expanded); otherwise it is a background hint (work block).
        scope: this.extensionCommandDepth > 0 ? "command" : undefined,
      });
    });
    // Same timing rule, same reason: without this the SDK drops extension
    // handler failures silently, where every CLI mode reports them.
    runtime.setExtensionErrorSink((session, error) => {
      this.host.log(`extension error (${error.extensionPath}) on ${error.event}: ${error.error}`);
      this.emit(session, {
        kind: "error",
        text: tf("extensionHandlerFailed", basename(error.extensionPath), error.event, error.error),
        scope: this.extensionCommandDepth > 0 ? "command" : undefined,
      });
      // A handler that threw is a handler that ran.
      if (this.activity.markExtension(error.extensionPath)) this.postResourceListing();
    });
    // Live UI state rather than transcript history, so these two stay out of
    // `histories` and are re-sent whenever the displayed session changes.
    runtime.setExtensionStatusSink((session, update) => {
      const entries = this.extensionStatuses.get(session.sessionId) ?? new Map<string, string>();
      if (update.text === undefined) entries.delete(update.key);
      else entries.set(update.key, update.text);
      this.extensionStatuses.set(session.sessionId, entries);
      if (this.isDisplayed(session)) this.postExtensionStatus();
    });
    runtime.setExtensionWidgetSink((session, update) => {
      const entries = this.extensionWidgets.get(session.sessionId) ?? new Map<string, ExtensionWidget>();
      if (update.lines === undefined) entries.delete(update.key);
      else entries.set(update.key, { key: update.key, lines: update.lines, placement: update.placement });
      this.extensionWidgets.set(session.sessionId, entries);
      if (this.isDisplayed(session)) this.postExtensionWidgets();
    });
    // Custom providers are configured by hand in models.json (see
    // `model-config.ts`). Saving that file is its only "apply" gesture, so a
    // save reloads it, the way the CLI reloads it when `/model` opens.
    this.modelsConfigWatcher = vscode.workspace.onDidSaveTextDocument((document) => {
      if (isModelsConfigPath(document.uri.fsPath)) void this.reloadModelsConfig();
    });
    // The delegation tool is built into the session's tool set at construction
    // time, and `reload()` keeps the host's `customTools`, so a changed setting
    // cannot reach a conversation already under way. Debounced because the
    // Settings editor fires per edited key, and three edits must not mean three
    // session rebuilds.
    this.settingsWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!affectsSubagentConfig(event, this.runtime.cwd)) return;
      if (this.subagentConfigTimer) clearTimeout(this.subagentConfigTimer);
      this.subagentConfigTimer = setTimeout(() => {
        this.subagentConfigTimer = undefined;
        void this.applySubagentConfigChange();
      }, SUBAGENT_SETTING_DEBOUNCE_MS);
    });
  }

  /**
   * React to a changed subagent setting.
   *
   * The session's tool set is fixed at construction, so new values can only
   * land when the runtime builds its next session — which is any session
   * replacement (new, switch, fork, import) and the next window start, not just
   * a brand new conversation.
   *
   * An *empty* session is the one case this host can simply rebuild: there is
   * no conversation to throw away, so the objection that made this a notice in
   * the first place does not apply. It is also the case with no way out — "new
   * session" is disabled on an already-empty one, leaving only a window reload.
   * Nothing is lost: an unwritten session never existed on disk (the SDK
   * persists at the first assistant message), and a named-but-empty one keeps
   * its file and stays in the session list.
   */
  private async applySubagentConfigChange(): Promise<void> {
    if (this.disposed) return;
    const before = this.runtime.builtSubagentConfig;
    const now = readSubagentConfig(this.runtime.cwd);
    // Re-saving the same values, or touching another key of the same section,
    // must cost neither a rebuild nor a notice.
    if (now.enabled === before.enabled && now.maxSubagents === before.maxSubagents && now.defaultModel === before.defaultModel) {
      return;
    }
    if (!this.canRebuildForSubagentConfig()) {
      this.emitCommandStatus(t("subagentSettingChanged"));
      return;
    }
    try {
      await this.runtime.newSession();
      await this.attach();
    } catch (error) {
      this.reportError(this.runtime.session, "subagent settings rebuild failed", error, "command");
      return;
    }
    // After `attach()`, so it lands in the transcript of the session that was
    // built, not the one that was just replaced.
    this.emitCommandStatus(t("subagentSettingApplied"));
  }

  /** Whether the displayed session can be rebuilt without losing anything. */
  private canRebuildForSubagentConfig(): boolean {
    if (this.view.kind !== "live") return false;
    const session = this.runtime.session;
    if (session.messages.length > 0) return false;
    if (session.isStreaming || session.isCompacting) return false;
    // A delegation run outlives the parent's turn; rebuilding under it would
    // leave lanes writing on behalf of a session that is gone.
    return !this.runtime.subagents.isRunning;
  }

  /**
   * Re-read `~/.pi/agent/models.json` and report the outcome in the transcript.
   *
   * No network: only the local file changed, and remote catalogues are already
   * refreshed on login/logout, as in the CLI.
   */
  private async reloadModelsConfig(): Promise<void> {
    const session = this.runtime.session;
    const before = { loaded: this.loadedModelIds(), available: new Set(this.availableModelRefs()) };
    try {
      await this.runtime.modelRuntime.refresh({ allowNetwork: false, signal: this.runtime.signal });
      const failed = await this.reportModelsConfigError(session);
      await this.rescopeModels();
      await this.postModels();
      await this.postState();
      if (failed) return;
      const available = await this.runtime.getAvailableModels();
      const lines = [tf("modelsConfigReloaded", available.length)];
      lines.push(...this.describeModelChanges(before, available));
      this.emit(session, { kind: "status", text: lines.join("\n"), scope: "command" });
    } catch (error) {
      if (this.disposed) return;
      this.reportError(session, "models.json reload failed", error, "command");
    }
  }

  /** Every loaded model, auth aside, as `provider` -> model ids. */
  private loadedModelIds(): Map<string, Set<string>> {
    const byProvider = new Map<string, Set<string>>();
    for (const model of this.runtime.modelRuntime.getModels()) {
      const ids = byProvider.get(model.provider) ?? new Set<string>();
      ids.add(model.id);
      byProvider.set(model.provider, ids);
    }
    return byProvider;
  }

  /** `provider/modelId` of everything the picker would currently offer. */
  private availableModelRefs(): string[] {
    return this.runtime.modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`);
  }

  /**
   * Explain what the edit actually produced.
   *
   * pi loads a provider's models regardless of auth but only offers the
   * authenticated ones, so models added behind a credential that does not
   * resolve (a placeholder, or a `$VAR` the VS Code process cannot see) are
   * nowhere to be found. Nothing else reports that: `getError()` stays empty
   * because the file itself is perfectly valid.
   */
  private describeModelChanges(
    before: { loaded: Map<string, Set<string>>; available: Set<string> },
    available: readonly { provider: string; id: string }[],
  ): string[] {
    const lines: string[] = [];
    const added = available
      .map((model) => `${model.provider}/${model.id}`)
      .filter((reference) => !before.available.has(reference));
    if (added.length > 0) lines.push(tf("modelsConfigAdded", added.join(", ")));
    const availableIds = new Set(available.map((model) => `${model.provider}/${model.id}`));
    for (const [provider, ids] of this.loadedModelIds()) {
      if (this.runtime.modelRuntime.getProviderAuthStatus(provider).configured) continue;
      // Only providers this save changed; the rest would repeat on every edit.
      const hidden = [...ids].filter(
        (id) => !before.loaded.get(provider)?.has(id) && !availableIds.has(`${provider}/${id}`),
      );
      if (hidden.length > 0) lines.push(tf("modelsConfigUnauthenticated", provider, hidden.length));
    }
    return lines;
  }

  /**
   * Surface a broken models.json the way every CLI mode does. Without this a
   * typo silently drops the custom providers that file defines.
   *
   * Returns whether an error is currently configured.
   */
  private async reportModelsConfigError(session: AgentSession): Promise<boolean> {
    const error = this.runtime.modelRuntime.getError();
    // A file with no configuration at all is the one "error" with an obvious,
    // lossless repair: pi rejects both an empty file and `{}`, while an empty
    // `providers` map says the same thing in a form it accepts. Saving the
    // repair re-runs this reload, which then reports the real state.
    if (error && (await repairEmptyModelsConfig())) {
      this.emit(session, { kind: "status", text: t("modelsConfigRepaired"), scope: "command" });
      this.modelsConfigError = undefined;
      return true;
    }
    if (error && error !== this.modelsConfigError) {
      this.emit(session, { kind: "error", text: tf("modelsConfigError", error), scope: "command" });
    }
    this.modelsConfigError = error;
    return Boolean(error);
  }

  /** Subscribe to the current session and push the initial state. */
  async attach(): Promise<void> {
    const started = Date.now();
    this.unsubscribe?.();
    const session = this.runtime.session;
    // A new session is always entered live, and its lanes start empty: lanes
    // belong to the session that spawned them.
    this.view = { kind: "live" };
    this.lanes = [];
    this.laneSessions.clear();
    this.parentActivityWhileAway = false;
    this.histories.clear();
    this.extensionStatuses.clear();
    this.extensionWidgets.clear();
    this.compactionQueues.clear();
    this.activity.reset();
    this.skillIndex = buildSkillIndex(session);
    this.promptIndex = buildPromptIndex(session);
    const events = this.buildHistory(session);
    // Replayed assistant output proves the system prompt — context files
    // included — already went to the model in this session.
    this.activity.noteHistory(events);
    this.histories.set(session.sessionId, events);
    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(session, event));
    this.rememberSession();
    const built = Date.now();
    // Get the transcript on screen first: binding extensions and collecting
    // resources are the slow parts and the webview needs none of them to
    // render history. Until this arrives the webview shows a loading row.
    this.postHistory();
    const posted = Date.now();
    await this.runtime.bindExtensions();
    // session_start (and resources_discover) have fired by now.
    this.activity.noteBind(session);
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
    // A models.json broken outside the sidebar must not stay invisible.
    await this.reportModelsConfigError(session);
  }

  /**
   * Tell the host which session is live, whenever that changes.
   *
   * A brand new session already has a path, but the file behind it is written
   * on the first append — until then there is nothing for the next window to
   * reopen, and `undefined` is what says "the user was sitting in a new,
   * still-empty session". Cheap enough to call per event: once the file is
   * known to exist the first comparison short-circuits, and before that the
   * session is by definition idle.
   */
  private rememberSession(): void {
    const file = this.runtime.session.sessionFile;
    if (this.remembered && this.remembered.file === file) return;
    const resumable = file !== undefined && existsSync(file) ? file : undefined;
    if (this.remembered && this.remembered.file === resumable) return;
    this.remembered = { file: resumable };
    this.host.rememberSession?.(resumable);
  }

  /**
   * The CLI-style startup listing ([Context] / [Skills] / [Prompts] /
   * [Extensions] / [Tools]), shown above the transcript when the header's
   * resources button is toggled on.
   */
  postResources(): void {
    try {
      // Extensions and skills are (re)loaded by now, so refresh the matchers too.
      this.skillIndex = buildSkillIndex(this.runtime.session);
      this.promptIndex = buildPromptIndex(this.runtime.session);
    } catch (error) {
      this.host.log(`failed to refresh resource matchers: ${describe(error)}`);
    }
    this.postResourceListing();
  }

  /**
   * Re-send the listing alone, for the cheap case: only the "took effect here"
   * marks changed, so the matchers behind them are still current.
   */
  private postResourceListing(): void {
    try {
      this.host.post({ type: "resources", sections: collectResourceSections(this.runtime, this.activity) });
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
    const session = this.displayedSession;
    // SYSTEM.md replaces the SDK's default prompt, including the absolute paths
    // that teach the model where Pi's bundled docs and examples live.
    const systemPromptOverridden = Boolean(session.resourceLoader.getSystemPromptSource());
    // Part of the new-session notice rather than a transcript event: it says
    // how this session is wired, not that something happened in it. Sent as an
    // event it would also evict the very placeholder it belongs to.
    const shadowedPath = this.runtime.shadowedSubagentExtension;
    const shadowedSubagent = shadowedPath
      ? { path: shadowedPath, subagentEnabled: this.runtime.subagentEnabled }
      : undefined;
    if (this.view.kind === "replay") {
      this.host.post({
        type: "history",
        events: [...this.view.events],
        transcriptId: this.view.file,
        systemPromptOverridden,
        shadowedSubagent,
      });
      this.postEntryIds();
      return;
    }
    const events = this.histories.get(session.sessionId) ?? this.buildHistory(session);
    this.histories.set(session.sessionId, events);
    // A replay of a still-streaming session must not close its open work
    // block in the webview; live events keep appending to the same card.
    this.host.post({
      type: "history",
      events: [...events],
      live: session.isStreaming,
      transcriptId: session.sessionId,
      systemPromptOverridden,
      shadowedSubagent,
    });
    // Every replay rebuilds the bubbles, so their entry bindings must follow.
    this.postEntryIds();
    // Extension-owned surfaces belong to the session now on screen.
    this.postExtensionStatus();
    this.postExtensionWidgets();
  }

  /** True while `session` is the one the webview is currently showing. */
  private isDisplayed(session: AgentSession): boolean {
    return this.view.kind !== "replay" && this.displayedSession === session;
  }

  /**
   * The session whose live state the UI reflects.
   *
   * A replay shows a static transcript but still reports the runtime session's
   * model, stats and name: those describe where the user *is*, and a replay is
   * a detour, not a move.
   */
  private get displayedSession(): AgentSession {
    return this.view.kind === "lane" ? this.view.session : this.runtime.session;
  }

  /**
   * Push the extension status entries and widgets of the displayed session.
   *
   * A preview shows a transcript the extensions are not bound to, so it gets an
   * empty set rather than the live session's, matching what the transcript does.
   */
  private postExtensionStatus(): void {
    if (this.disposed) return;
    const session = this.displayedSession;
    const entries = this.view.kind === "replay" ? undefined : this.extensionStatuses.get(session.sessionId);
    this.host.post({
      type: "extensionStatus",
      items: [...(entries?.entries() ?? [])].map(([key, text]) => ({ key, text })),
    });
  }

  private postExtensionWidgets(): void {
    if (this.disposed) return;
    const session = this.displayedSession;
    const entries = this.view.kind === "replay" ? undefined : this.extensionWidgets.get(session.sessionId);
    this.host.post({ type: "extensionWidgets", items: [...(entries?.values() ?? [])] });
  }

  /**
   * Drop one session's extension-owned status entries and widgets.
   *
   * Used on reload, between the old extension instances being torn down and
   * `session_start` reaching the new ones: those entries belong to the old
   * instances, and the new ones republish whatever is still true — the same
   * contract `attach()` relies on.
   */
  private clearExtensionUiState(session: AgentSession): void {
    this.extensionStatuses.delete(session.sessionId);
    this.extensionWidgets.delete(session.sessionId);
    if (!this.isDisplayed(session)) return;
    this.postExtensionStatus();
    this.postExtensionWidgets();
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
    // Only the live parent transcript is actionable. A run in progress blocks it
    // too: rewriting history under a running delegation would strand its lanes.
    const actionable = this.view.kind === "live" && !this.activeRun;
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
    const session = this.displayedSession;
    const model = session.model as { id?: string; provider?: string } | undefined;
    let needsAuth = false;
    try {
      needsAuth = (await this.runtime.getAvailableModels(probe.signal)).length === 0;
    } catch {
      // Availability check failing (or being cancelled) must not block the chat UI.
    }
    if (postVersion !== this.statePostVersion || this.disposed) return;
    const replay = this.view.kind === "replay" ? this.view : undefined;
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
      // In a replay the live run keeps going, but the transcript on screen is
      // static history: no stop button, no working indicator.
      isStreaming: replay ? false : session.isStreaming,
      isCompacting: replay ? false : session.isCompacting,
      needsAuth,
      messageCount: session.messages.length,
      // Delegation survives a replay: a subagent whose live session is gone is
      // *shown* as a replay of its session file, and dropping the delegation
      // here would strip exactly the framing that makes it readable as a
      // subagent. What a replay means is decided in `delegationState`, once.
      delegation: this.delegationState(session),
      preview: replay ? { file: replay.file, title: replay.title } : undefined,
      // Only the live parent transcript takes input. Both other views are
      // read-only, which is the whole point of `View` having three cases.
      inputDisabled: this.view.kind !== "live",
      stats: this.collectStats(session),
    };
    this.host.post({ type: "state", state });
  }

  /** Header title: user-set name, else the first user message, else empty. */
  private sessionDisplayName(session: AgentSession): string | undefined {
    return session.sessionManager.getSessionName()
      ?? firstUserLine(session.messages as Array<{ role?: string; content?: unknown }>);
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
    return buildHistoryEntryEvents(session.sessionManager.getBranch(), this.runtime.cwd, this.skillIndex, this.promptIndex);
  }

  private emit(session: AgentSession, event: ChatEvent): void {
    if (this.disposed) return;
    const placed = this.placeNotice(session, event);
    const history = this.histories.get(session.sessionId) ?? this.buildHistory(session);
    history.push(placed);
    this.histories.set(session.sessionId, history);
    if (this.isDisplayed(session)) {
      this.host.post({ type: "event", event: placed });
    }
  }

  /**
   * Decide where a notice renders when the emitter did not say.
   *
   * Run-scoped notices (retry, compaction, background extension hints) are
   * folded into the work block of the execution process they belong to. While
   * nothing is running there is no such process, and the webview would *open* a
   * work block just to hold the notice — one that then shows as "running" until
   * some later turn happens to close it, and that hides a message the user has
   * no reason to look for inside an execution process. So an idle notice is
   * placed at the top level, where notices the user asked for go.
   *
   * Emitters that are a direct answer to a user action still say "command"
   * explicitly: those must stay at the top level even when a run is in flight.
   */
  private placeNotice(session: AgentSession, event: ChatEvent): ChatEvent {
    if (event.kind !== "status" && event.kind !== "error") return event;
    if (event.scope !== undefined) return event;
    if (session.isStreaming || session.isCompacting) return event;
    return { ...event, scope: "command" };
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

  private onSessionEvent(session: AgentSession, event: AgentSessionEvent): void {
    // The file appears mid-conversation (lazily, on the first append), so the
    // value recorded at attach time goes stale as soon as the user speaks.
    if (session === this.runtime.session) this.rememberSession();
    const toolKey = (id: string) => `${session.sessionId}:${id}`;
    // Extensions subscribed to this event have just run, and a starting run
    // means the context files went out with the system prompt.
    if (this.activity.noteSessionEvent(session, event.type)) this.postResourceListing();
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
        if (this.view.kind === "replay" && !this.activeRun && session === this.runtime.session && !session.isStreaming) {
          const file = this.view.file;
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
        // Assistant messages carry the provider's finalized usage, cache and
        // cost figures. Refresh after the SDK persists the message so the
        // footer updates after every model response, including responses that
        // only request a tool, rather than waiting for the whole agent run.
        // AgentSession notifies subscribers before appending message_end to its
        // SessionManager, so defer collection until the current stack unwinds.
        if (event.message.role === "assistant") {
          queueMicrotask(() => void this.postState());
          // The SDK defers writing a brand-new session to disk until the first
          // assistant message completes; refresh here so the sessions list can
          // show the new session before the whole run settles.
          this.refreshSessions();
        }
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
        this.emit(session, {
          kind: "tool_update",
          id: event.toolCallId,
          text: resultText(event.partialResult),
          // Live payload of a tool that has not finished. Sanitized on the same
          // terms as a final result: it crosses `postMessage` too.
          details: sanitizeToolDetails(event.toolName, event.partialResult?.details),
        });
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
          details: sanitizeToolDetails(event.toolName, event.result?.details),
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

  onRunStarted(run: SubagentRun): void {
    this.activeRun = run;
    this.mergeLanes(run.lanes);
    // The view is never moved for the user: not into a lane when a run starts,
    // not back out when one ends. Switching between agent transcripts is the
    // user's action alone, so a run starting while the user is away from the
    // parent only marks it as having moved on. "Away" covers a replayed
    // subagent too, which is what a lane becomes once its session is gone.
    if (this.view.kind !== "live") this.parentActivityWhileAway = true;
    void this.postState();
    this.refreshSessions();
  }

  /** Add or refresh lane snapshots, keeping earlier runs' lanes reachable. */
  private mergeLanes(lanes: readonly LaneState[]): void {
    for (const lane of lanes) {
      const index = this.lanes.findIndex((known) => known.id === lane.id);
      if (index >= 0) this.lanes[index] = lane;
      else this.lanes.push(lane);
    }
  }

  onLaneStarted(run: SubagentRun, lane: LaneState, session: AgentSession): void {
    if (this.activeRun !== run) return;
    this.laneSessions.set(lane.id, session);
    // Seed the lane transcript with its task, the way the parent's transcript
    // starts from a user message.
    this.histories.set(session.sessionId, [{ kind: "user_message", text: lane.task }]);
    this.mergeLanes(run.lanes);
    void this.postState();
    this.refreshSessions();
  }

  onLaneChanged(run: SubagentRun, _lane: LaneState): void {
    if (this.activeRun !== run) return;
    this.mergeLanes(run.lanes);
    void this.postState();
  }

  onLaneEvent(run: SubagentRun, lane: LaneState, event: AgentSessionEvent): void {
    if (this.activeRun !== run) return;
    const session = this.laneSessions.get(lane.id);
    if (session) this.onSessionEvent(session, event);
  }

  /**
   * A lane could not use a model the user configured for it.
   *
   * Lands in the parent's transcript, where the user is, and nowhere in the
   * report the parent agent receives: it did not pick that model and cannot fix
   * the spelling or the missing credentials, so telling it would only invite it
   * to "correct" arguments it never sent.
   */
  onLaneNotice(run: SubagentRun, lane: LaneState, notice: LaneNotice): void {
    if (this.activeRun !== run) return;
    const source = t("subagentModelSourceSetting");
    const using = notice.using ?? t("subagentModelFallbackParent");
    this.emit(run.parent, {
      kind: "status",
      text: tf("subagentModelFallback", lane.title, notice.requested, source, using),
    });
  }

  onRunFinished(run: SubagentRun): void {
    if (this.activeRun !== run) return;
    for (const lane of run.lanes) {
      const session = this.laneSessions.get(lane.id);
      if (!session) continue;
      this.emit(session, {
        kind: lane.status === "completed" ? "status" : "error",
        text: lane.summary ?? lane.status,
      });
    }
    this.activeRun = undefined;
    this.mergeLanes(run.lanes);
    // Deliberately not switching back: a user reading a lane keeps reading it,
    // and the back action grows a "parent moved on" marker instead.
    if (this.view.kind !== "live") this.parentActivityWhileAway = true;
    void this.postState();
    this.refreshSessions();
  }

  /**
   * Delegation as the displayed session sees it.
   *
   * Survives the end of the run so a lane opened by the user stays readable,
   * and so the parent's card keeps its final tally instead of vanishing.
   */
  private delegationState(session: AgentSession): ChatState["delegation"] {
    // A subagent shown by replaying its session file — all that is left of it
    // after a window reload — is still a subagent as far as the user is
    // concerned, so it keeps the lane framing.
    if (this.view.kind === "replay" && this.view.laneTitle !== undefined) {
      const file = this.view.file;
      const known = this.lanes.find((lane) => lane.sessionFile === file);
      const lane: DelegationLane = known
        ? this.toDelegationLane(known)
        : { id: REPLAYED_LANE_ID, title: this.view.laneTitle, scope: [], status: "completed", writtenFiles: [] };
      return {
        role: "child",
        lanes: [lane],
        currentLaneId: lane.id,
        running: Boolean(this.activeRun),
        parentHasNewActivity: this.parentActivityWhileAway,
      };
    }
    if (this.lanes.length === 0) return undefined;
    const lanes = this.lanes.map((lane) => this.toDelegationLane(lane));
    const running = Boolean(this.activeRun);
    if (this.view.kind === "lane") {
      // A lane id that no longer matches any known lane would render a banner
      // with no lane to name; fall through to the parent's view instead.
      const laneId = this.view.laneId;
      if (this.lanes.some((lane) => lane.id === laneId)) {
        return { role: "child", lanes, currentLaneId: laneId, running, parentHasNewActivity: this.parentActivityWhileAway };
      }
    }
    if (session === this.runtime.session) return { role: "parent", lanes, running };
    return undefined;
  }

  private toDelegationLane(lane: LaneState): DelegationLane {
    return {
      id: lane.id,
      title: lane.title,
      scope: [...lane.scope],
      status: lane.status,
      progress: lane.progress,
      writtenFiles: [...lane.writtenFiles],
      bashMayHaveWritten: lane.bashMayHaveWritten || undefined,
      scopeViolations: lane.scopeViolations || undefined,
      sessionId: lane.sessionId,
      sessionFile: lane.sessionFile,
      durationMs: lane.endedAt ? lane.endedAt - lane.startedAt : undefined,
    };
  }

  /**
   * Switch the displayed transcript to one lane, or back to the parent.
   *
   * A lane stays viewable as a lane after it finishes — its child session is
   * kept until the next run — so this is the path for both a running and a
   * completed subagent. Only once the session is gone (a transcript replayed in
   * a later session, say) does it fall back to an ordinary read-only preview,
   * which is also the only case where the subagent framing is genuinely lost.
   */
  private showLane(laneId?: string, fallbackFile?: string, laneTitle?: string): void {
    if (!laneId) {
      this.setView({ kind: "live" });
      return;
    }
    const session = this.laneSessions.get(laneId);
    if (!session) {
      // The child session is gone (an earlier window, or a session switch), but
      // its transcript is on disk. Replay it *as that subagent*.
      if (fallbackFile) void this.previewSession(fallbackFile, laneTitle ?? "");
      return;
    }
    this.setView({ kind: "lane", laneId, session });
  }

  /**
   * Switch what the webview shows and push everything derived from it.
   *
   * The single place a view change happens, so no caller can update part of the
   * UI and forget the rest.
   */
  private setView(view: View): void {
    this.view = view;
    if (view.kind === "live") this.parentActivityWhileAway = false;
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
      case "showLane":
        this.showLane(message.laneId, message.sessionFile, message.title);
        break;
      case "stopLane":
        await this.runtime.subagents.stopLane(message.laneId);
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
          refreshModels: async () => {
            await this.refreshModelCatalog();
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
      case "copyText":
        await vscode.env.clipboard.writeText(message.text);
        break;
    }
  }

  private async abortDisplayedSession(): Promise<void> {
    if (this.view.kind === "replay") return; // static transcript; nothing to stop
    const displayed = this.displayedSession;
    if (displayed.isCompacting) {
      displayed.abortCompaction();
      return;
    }
    // Inside a lane the stop button stops that lane only; the rest of the run
    // continues and the parent still receives a full report.
    if (this.view.kind === "lane") {
      await this.runtime.subagents.stopLane(this.view.laneId);
      return;
    }
    if (!this.activeRun) {
      await this.runtime.session.abort();
      return;
    }
    // From the parent it means the whole run: every lane, then the parent.
    await this.runtime.subagents.stopAll();
    this.runtime.session.clearQueue();
    await this.runtime.session.abort();
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
    if (this.view.kind !== "live" || this.activeRun) return;
    if (action !== "label" && this.guardStreaming()) return;
    const ui = this.builtinActions();
    try {
      if (action === "switch") await switchToEntry(this.runtime, entryId, ui);
      else if (action === "fork") await forkFromEntry(this.runtime, entryId, ui);
      else await editEntryLabel(this.runtime, entryId, ui);
    } catch (error) {
      this.reportError(this.runtime.session, `${action} failed`, error, "command");
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
  private async previewSession(file: string, laneTitle?: string): Promise<void> {
    // Asking to replay the live session means "take me back to it" — what the
    // sessions list sends when the user picks the parent while a lane is on
    // screen. Replaying it for real would swap a live transcript for a static
    // copy of itself.
    if (file === this.runtime.session.sessionFile) {
      this.setView({ kind: "live" });
      return;
    }
    try {
      const manager = SessionManager.open(file);
      const events = buildHistoryEntryEvents(manager.getBranch(), this.runtime.cwd, this.skillIndex, this.promptIndex);
      const firstUser = events.find((event) => event.kind === "user_message") as { text?: string } | undefined;
      this.setView({ kind: "replay", file, title: (firstUser?.text ?? "").split("\n")[0] ?? "", events, laneTitle });
      this.refreshSessions();
    } catch (error) {
      this.reportError(this.runtime.session, "session preview failed", error, "command");
    }
  }

  /** Return from a read-only replay to the live transcript. */
  private closePreview(): void {
    if (this.view.kind !== "replay") return;
    this.setView({ kind: "live" });
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
    // Only the parent takes input, and only when it is the live view. Both other
    // views are read-only; a queued prompt from them would land in a session the
    // user is not looking at.
    if (this.view.kind !== "live") return;
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
        this.reportError(this.runtime.session, "file reference rejected", error, "command");
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
    // Resolved before `prompt()` runs: it rewrites `/template` into the expanded
    // body and swallows extension commands entirely.
    const invocation = resolveInvocation(session, trimmed);
    const extensionCommand = invocation.isExtensionCommand;
    if (session.isCompacting && !extensionCommand) {
      this.queueDuringCompaction(session, trimmed, streamingBehavior ?? "followUp");
      return;
    }

    const streaming = session.isStreaming && !extensionCommand;
    const mode = streaming ? (streamingBehavior ?? "followUp") : undefined;
    // The SDK expands `/skill:<name>` inside prompt(); the text emitted here is
    // still the command form, so the skill is resolved from the command itself.
    this.emit(session, {
      kind: "user_message",
      text: trimmed,
      mode,
      skill: invokedSkill(this.skillIndex, trimmed),
      prompt: invocation.prompt,
      extension: invocation.extension,
    });
    try {
      if (extensionCommand) this.extensionCommandDepth += 1;
      await session.prompt(trimmed, {
        streamingBehavior: mode,
      });
    } catch (error) {
      this.reportError(this.runtime.session, "prompt failed", error);
    } finally {
      if (extensionCommand) this.extensionCommandDepth -= 1;
      await this.postState();
    }
  }

  /** Sign in to a provider; on success re-check availability and refresh the UI. */
  async login(): Promise<boolean> {
    const changed = await loginFlow(this.runtime, (message) => this.host.log(message));
    if (changed) {
      await this.rescopeModels();
      await this.postModels();
      await this.postState();
    }
    return changed;
  }

  async logout(): Promise<boolean> {
    const changed = await logoutFlow(this.runtime, (message) => this.host.log(message));
    if (changed) {
      await this.rescopeModels();
      await this.postModels();
      await this.postState();
    }
    return changed;
  }

  /**
   * Re-resolve the session's frequently used models after availability changed.
   *
   * `session.scopedModels` — the composer quick menu's source — is resolved at
   * session build and when the list itself is edited, so an auth change leaves
   * it stale: a logged-out provider stays in the quick menu (and a newly
   * authenticated one stays out) until the next session. Failures are logged,
   * not fatal: only the quick menu's contents lag, the chat is unaffected.
   */
  private async rescopeModels(): Promise<void> {
    try {
      await this.runtime.rescopeSessionModels();
    } catch (error) {
      this.host.log(`scoped models refresh failed: ${describe(error)}`);
    }
  }

  /**
   * Re-fetch every provider's model catalogue from the network, on demand.
   *
   * The settings menu's "refresh" entry. A failed catalogue fetch is not
   * fatal — the provider keeps its cached list — but nothing retried it
   * before; login/logout are the only automatic triggers. Same call the CLI's
   * model selector makes each time it opens.
   */
  async refreshModelCatalog(): Promise<void> {
    const session = this.runtime.session;
    const timeout = AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS);
    let result: ModelsRefreshResult;
    try {
      result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t("modelsRefreshing") },
        () => this.runtime.refreshModelCatalog(timeout),
      );
    } catch (error) {
      this.reportError(session, "model catalog refresh failed", error, "command");
      return;
    }
    if (this.disposed) return;
    if (result.aborted && timeout.aborted) {
      this.emit(session, { kind: "error", text: t("modelsRefreshTimedOut"), scope: "command" });
    } else if (result.errors.size > 0) {
      // Same shape as the login/logout warning: provider names plus the first
      // underlying reason (with `cause` unwrapped by `describe()`).
      const names = [...result.errors.keys()].map((id) => this.runtime.modelRuntime.getProvider(id)?.name ?? id);
      this.emit(session, {
        kind: "error",
        text: tf("modelRefreshFailed", names.join(", "), describe([...result.errors.values()][0])),
        scope: "command",
      });
    } else {
      // Snapshot, not `getAvailable()`: the catalogue is what this action
      // fetched, and a fresh auth probe would only add its own failure modes.
      this.emit(session, {
        kind: "status",
        text: tf("modelsRefreshed", this.runtime.modelRuntime.getAvailableSnapshot().length),
        scope: "command",
      });
    }
    await this.rescopeModels();
    await this.postModels();
    await this.postState();
  }

  /**
   * `/reload`, including the sidebar bookkeeping around it. Shared with
   * `ctx.reload()` from an extension command, which must behave identically.
   */
  private async reloadResources(): Promise<void> {
    // reload() replaces the extension instances in place; the session object
    // itself stays, so subscriptions and histories survive.
    const session = this.runtime.session;
    await this.runtime.reloadResources({
      beforeSessionStart: () => this.clearExtensionUiState(session),
    });
    // The reloaded extension set has just received session_start.
    this.activity.noteBind(session);
    this.skillIndex = buildSkillIndex(session);
    this.promptIndex = buildPromptIndex(session);
    this.postCommands();
    this.postResources();
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
          items.map((item) => ({
            label: item.title,
            description: formatLocalTimestamp(item.timestamp),
            file: item.file,
          })),
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
      login: async () => {
        await this.login();
      },
      logout: async () => {
        await this.logout();
      },
      reload: async () => {
        await this.reloadResources();
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
    const displayedFile = this.view.kind === "replay" ? this.view.file : this.displayedSession.sessionFile;
    const runningFile = this.runtime.session.isStreaming || this.runtime.session.isCompacting
      ? this.runtime.session.sessionFile
      : undefined;
    // The badge spins and means "busy right now", so only lanes of a run still
    // in progress may carry it. Finished subagents are ordinary sessions.
    const runningLanes = new Set(
      (this.activeRun
        ? this.lanes.filter((lane) => lane.status === "running").map((lane) => lane.sessionFile)
        : []
      ).filter(Boolean) as string[],
    );
    const items: SessionListItem[] = sessions.map((info) => ({
      file: info.path,
      // The SDK stores an expanded <skill> block as the first user message.
      // Restore the command form so session lists show `/skill:name ...`
      // instead of the skill XML and its filesystem location.
      title: info.name || collapseSkillInvocation(info.firstMessage) || t("emptySessionTitle"),
      timestamp: info.modified?.toISOString(),
      current: Boolean(displayedFile) && info.path === displayedFile,
      running: Boolean(runningFile) && info.path === runningFile,
      delegationRole: runningLanes.has(info.path)
        ? "child"
        : this.activeRun && info.path === this.runtime.session.sessionFile
          ? "parent"
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

  /** Delete a session file after confirmation; sessions of the active run cannot be deleted. */
  private async deleteSession(file: string): Promise<void> {
    const runningLaneFiles = this.activeRun
      ? new Set(this.lanes.map((lane) => lane.sessionFile).filter(Boolean) as string[])
      : new Set<string>();
    if (file === this.runtime.session.sessionFile || runningLaneFiles.has(file)) {
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
   * via a short-lived SessionManager. Subagent sessions of a running call are
   * skipped (their JSONL is being appended to by the run).
   */
  private async renameSession(file: string): Promise<void> {
    const runningLaneFiles = this.activeRun
      ? new Set(this.lanes.map((lane) => lane.sessionFile).filter(Boolean) as string[])
      : new Set<string>();
    if (runningLaneFiles.has(file)) {
      vscode.window.showWarningMessage(t("renameRunningSession"));
      return;
    }
    const isActive = file === this.runtime.session.sessionFile;
    // Prefill the input with the title the list shows so a rename always edits
    // it instead of starting from scratch: an unnamed session is titled by its
    // first user message, so `getSessionName()` alone would leave the box empty
    // next to a row that clearly has a title. Inactive sessions read it off
    // their own file.
    let manager: SessionManager | undefined;
    let currentName: string | undefined;
    try {
      manager = isActive ? this.runtime.session.sessionManager : SessionManager.open(file);
      currentName = sessionTitle(manager);
    } catch (error) {
      this.reportError(this.runtime.session, "rename session failed", error, "command");
      return;
    }
    const value = (
      await vscode.window.showInputBox({ title: t("sessionNameTitle"), value: currentName ?? "" })
    )?.trim();
    if (!value) return;
    try {
      if (isActive) {
        this.runtime.session.setSessionName(value);
      } else {
        manager.appendSessionInfo(value);
      }
    } catch (error) {
      this.reportError(this.runtime.session, "rename session failed", error, "command");
      return;
    }
    await this.pushSessions();
  }

  dispose(): void {
    this.disposed = true;
    this.statePostVersion++;
    this.modelsConfigWatcher?.dispose();
    this.modelsConfigWatcher = undefined;
    this.settingsWatcher?.dispose();
    this.settingsWatcher = undefined;
    if (this.subagentConfigTimer) {
      clearTimeout(this.subagentConfigTimer);
      this.subagentConfigTimer = undefined;
    }
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
 * What the listing needs from the runtime. Structural so the offline
 * diagnostics can pass a bare session instead of a full `PiRuntime`.
 */
export interface ResourceHost {
  session: AgentSession;
  cwd: string;
}

/**
 * Build the CLI-style startup listing from the session's resource loader,
 * mirroring `interactive-mode`'s [Context] / [Skills] / [Prompts] /
 * [Extensions] sections, plus a [Tools] section the CLI has no equivalent for.
 * Empty sections are omitted, and the CLI's [Themes] section is dropped
 * entirely: the webview renders with VS Code theme variables, so a pi theme
 * would be listed as loaded while having no effect here.
 *
 * Only pi's own resource kinds are listed. Directory conventions invented by a
 * single extension (`~/.pi/agent/agents/`, for one) are deliberately absent:
 * pi has no loader for them, so listing them here would present one
 * extension's private layout as a first-class concept of this host.
 *
 * `activity` marks the rows that took effect in this session (see
 * `agent/activity.ts`); the diagnostics command omits it and gets a listing
 * without any "used here" marks.
 */
export function collectResourceSections(runtime: ResourceHost, activity?: ResourceActivity): ResourceSection[] {
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
    // Context files are inlined into the system prompt on every request, so
    // they are all in effect together, from the first request onwards.
    sections.push(
      sortedSection(
        "Context",
        contextFiles.map((file) => ({ ...entry(basename(file.path), file.path), ...(activity?.contextUsed ? { used: true } : {}) })),
      ),
    );
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
        ...extensions.map((extension) => ({
          ...entry(basename(extension.path), extension.path, (extension as { sourceInfo?: { origin?: string } }).sourceInfo),
          ...(activity?.isExtensionUsed(extension.path) ? { used: true } : {}),
        })),
        // A failed extension has no loaded file to open, so it keeps the error
        // as its row text, and is dimmed: it is configured but not in effect.
        ...extensionErrors.map((failure) => ({
          label: `${basename(failure.path)} (load failed)`,
          detail: `${failure.path}: ${String(failure.error)}`,
          inactive: true,
          scope: resourceScope(failure.path, runtime.cwd),
        })),
      ]),
    );
  }

  const tools = collectToolItems(runtime);
  if (tools.length > 0) {
    sections.push(sortedSection("Tools", tools));
  }

  return sections;
}

/**
 * Every tool the session has configured, whether or not it is active.
 *
 * pi registers seven built-in tools but only activates `read`/`bash`/`edit`/
 * `write` (`core/sdk.ts`), so `grep`/`find`/`ls` show up here as inactive until
 * an extension turns them on — which is exactly the question this row answers.
 * Built-in and SDK-provided tools carry a synthetic `<builtin:read>` path and
 * open nothing; tools registered by an extension keep that extension's file,
 * so the row leads to whoever provides them.
 */
function collectToolItems(runtime: ResourceHost): ResourceItem[] {
  const session = runtime.session;
  const active = new Set(session.getActiveToolNames());
  return session.getAllTools().map((tool) => {
    const sourceInfo = tool.sourceInfo as { path?: string; origin?: string } | undefined;
    const path = sourceInfo?.path && !sourceInfo.path.startsWith("<") ? sourceInfo.path : undefined;
    const hint = tool.description?.split("\n").find((line) => line.trim())?.trim();
    return {
      label: tool.name,
      scope: path ? resourceScope(path, runtime.cwd, sourceInfo) : ("builtin" as const),
      ...(path ? { path } : {}),
      ...(hint ? { hint } : {}),
      ...(active.has(tool.name) ? {} : { inactive: true }),
    };
  });
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
export function buildHistoryEvents(
  messages: readonly unknown[],
  cwd: string,
  skills: SkillIndex = EMPTY_SKILL_INDEX,
  prompts: PromptIndex = EMPTY_PROMPT_INDEX,
): ChatEvent[] {
  const events: ChatEvent[] = [];
  const toolArgs = new Map<string, unknown>();
  for (const message of messages) appendHistoryMessage(events, toolArgs, message, cwd, skills, prompts);
  return events;
}

/**
 * Replay the complete active branch rather than the compaction-aware model
 * context. Compaction entries become visible boundaries; their retainedTail is
 * deliberately not expanded because those messages already exist earlier in a
 * regular Pi session and would otherwise be duplicated.
 */
export function buildHistoryEntryEvents(
  entries: readonly SessionEntry[],
  cwd: string,
  skills: SkillIndex = EMPTY_SKILL_INDEX,
  prompts: PromptIndex = EMPTY_PROMPT_INDEX,
): ChatEvent[] {
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
      appendHistoryMessage(events, toolArgs, message, cwd, skills, prompts);
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
  prompts: PromptIndex,
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
    // Prompt templates leave no marker once expanded, so only placeholder-free
    // bodies can be traced back to their `/command` here.
    if (text.trim()) events.push({ kind: "user_message", text, skill, prompt: skill ? undefined : expandedPrompt(prompts, text) });
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
      details: sanitizeToolDetails(message.toolName ?? "", message.details),
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

