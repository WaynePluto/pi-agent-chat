import * as vscode from "vscode";
import { existsSync } from "node:fs";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { ChatBridge } from "./agent/bridge.js";
import { OriginalContentProvider } from "./agent/diff-view.js";
import { describeWithStack } from "./agent/errors.js";
import { PiRuntime, type StartupSession } from "./agent/runtime.js";
import type { ChatState, HostMessage, WebviewMessage } from "./shared/protocol.js";

export const CHAT_VIEW_ID = "piAgentChat.view";
export const CHAT_PANEL_TYPE = "piAgentChat.editor";
export const MAX_EDITOR_TAB_TITLE_CHARS = 32;

const LEGACY_LAST_SESSION_KEY = "piAgentChat.lastSession";
const SIDEBAR_LAST_SESSION_KEY = "piAgentChat.lastSession.sidebar";

/**
 * Two surface kinds, three regions the user thinks in: the sidebar view, and
 * editor panels — which VS Code lets sit either in this window's editor area or
 * in a floating window. The API draws no line between the latter two: a
 * `WebviewPanel` carries no window identity and `window.tabGroups` is read-only,
 * so a panel's region is bookkeeping here (`PanelRegion`), never a question the
 * API can answer.
 */
type SurfaceKind = "sidebar" | "editor";
type ControllerSlot = SurfaceKind | "background";

/** Where an editor panel currently sits. Corrected from `viewColumn`; see connectEditorPanel. */
type PanelRegion = "editor" | "window";

interface EditorPanelEntry {
  panel: vscode.WebviewPanel;
  surface: SurfaceConnection;
  region: PanelRegion;
}

interface LastSession {
  cwd: string;
  file: string | null;
}

/**
 * The session an editor tab was showing before a window reload.
 *
 * Editor tabs remember their own session in webview state (the second argument
 * of `deserializeWebviewPanel`) rather than in one workspace-level key: VS Code
 * restores every retained panel separately, so N tabs need N memories and a
 * shared slot would just have them overwrite each other.
 */
export function restoredSessionFile(state: unknown, cwd: string): string | undefined {
  if (state === null || typeof state !== "object") return undefined;
  const session = (state as { session?: unknown }).session;
  if (session === null || typeof session !== "object") return undefined;
  const { cwd: storedCwd, file } = session as { cwd?: unknown; file?: unknown };
  if (typeof file !== "string" || file.length === 0) return undefined;
  if (typeof storedCwd === "string" && storedCwd !== cwd) return undefined;
  return file;
}

/** Window-local ownership of persisted session files. */
export class SessionClaimRegistry<T extends object> {
  private readonly owners = new Map<string, T>();

  owner(file: string): T | undefined {
    return this.owners.get(sessionKey(file));
  }

  claim(file: string, owner: T): boolean {
    const key = sessionKey(file);
    const current = this.owners.get(key);
    if (current && current !== owner) return false;
    this.owners.set(key, owner);
    return true;
  }

  release(file: string, owner: T): void {
    const key = sessionKey(file);
    if (this.owners.get(key) === owner) this.owners.delete(key);
  }
}

/** Pure lifecycle rule pinned by host diagnostics. */
export function shouldDisposeHeadlessRuntime(options: {
  disposeWhenSettled: boolean;
  visible: boolean;
  busy: boolean;
  retainedSidebar: boolean;
}): boolean {
  return options.disposeWhenSettled && !options.visible && !options.busy && !options.retainedSidebar;
}

/** Pure dispatch rule pinned by host diagnostics. */
export function replacementStartupForRunningController(
  message: WebviewMessage,
  busy: boolean,
  claimedFile?: string,
): StartupSession | undefined {
  if (!busy) return undefined;
  if (message.type === "newSession") return { mode: "new" };
  if (message.type === "resumeSession" && message.file !== claimedFile) return { mode: "file", path: message.file };
  return undefined;
}

/** A visible claimed controller leaves a real GUI behind, so that source gets a fresh session. */
export function claimedSessionSourceStartup(location: "visible" | "background"): StartupSession | undefined {
  return location === "visible" ? { mode: "new" } : undefined;
}

/**
 * Pure ownership rule pinned by host diagnostics: the session files a
 * controller writes to, and therefore claims exclusively in this window.
 *
 * Takes no notice of what the controller's webview displays. A subagent
 * transcript or a replayed session on screen belongs to another writer, and
 * claiming it would both hand this controller's own file to whoever asks next
 * and turn a running task line into ordinary rows in every session list.
 */
export function ownedSessionFiles(options: {
  sessionFile?: string;
  runningLaneFiles?: readonly string[];
}): string[] {
  const owned = new Set<string>();
  if (options.sessionFile) owned.add(options.sessionFile);
  for (const file of options.runningLaneFiles ?? []) owned.add(file);
  return [...owned];
}

/**
 * A session with no messages has nothing worth carrying to another surface:
 * every target already has an "open a new session in …" menu item, which is
 * exactly what moving an empty session amounts to. Gates the visibility of
 * the "move this session" commands (see `updateMoveMenuContext`).
 */
export function isMovableSessionState(state: ChatState | undefined): boolean {
  return (state?.messageCount ?? 0) > 0;
}

/**
 * Owns all top-level chat runtimes in one VS Code window.
 *
 * Webviews are replaceable presentation surfaces. A controller (runtime +
 * bridge) may move between surfaces, and a closed editor panel may leave its
 * controller headless until the current run settles. Session files are claimed
 * by controllers, not webviews, so a headless run cannot be resumed by a
 * second runtime and appended to concurrently.
 */
export class ChatSurfaceManager implements vscode.Disposable {
  private sidebar?: SurfaceConnection;
  private sidebarController?: ChatController;
  /** Every chat tab in this window, in either region. Keyed by its surface. */
  private readonly panels = new Map<SurfaceConnection, EditorPanelEntry>();
  /** The tab a title-bar command applies to; VS Code evaluates those menus for the active editor. */
  private activePanel?: EditorPanelEntry;
  private readonly controllers = new Set<ChatController>();
  private readonly claims = new SessionClaimRegistry<ChatController>();
  private readonly sessionsChangedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeSessions = this.sessionsChangedEmitter.event;
  private nextControllerId = 1;
  private creationQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  /** Last context values pushed for the move-menu `when` clauses; see updateMoveMenuContext. */
  private moveMenuContext?: { sidebarEmpty: boolean; tabEmpty: boolean; tabRegion: PanelRegion };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    readonly diffProvider: OriginalContentProvider,
    readonly cwd: string,
  ) {}

  async resolveSidebar(view: vscode.WebviewView): Promise<void> {
    this.sidebar?.dispose();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    let surface!: SurfaceConnection;
    surface = new SurfaceConnection(
      "sidebar",
      view.webview,
      () => void vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`),
      (message) => this.handleSurfaceMessage(surface, message),
      () => this.onSidebarDisposed(surface),
      () => renderChatHtml(view.webview, this.context.extensionUri, "sidebar"),
    );
    this.sidebar = surface;
    view.onDidDispose(() => surface.dispose());

    try {
      const controller = this.sidebarController ?? await this.createController("sidebar", this.startupSession("sidebar"));
      this.sidebarController = controller;
      surface.bind(controller);
    } catch (error) {
      this.reportError(surface, error);
    }
  }

  /**
   * Move the sidebar session into a new editor tab (region B).
   *
   * Always a new tab: "move this session to the editor area" must not silently
   * displace whatever another tab is showing. The vacated sidebar immediately
   * gets a fresh session.
   */
  async openEditor(): Promise<void> {
    try {
      const moved = this.sidebarController;
      const panel = this.createEditorPanel();
      if (moved) {
        moved.setSlot("editor");
        this.bindEditorPanel(panel, moved);
        await this.refillSurface("sidebar", this.sidebar);
      } else {
        const controller = await this.createController("editor", { mode: "new" });
        this.bindEditorPanel(panel, controller);
      }
      panel.reveal(vscode.ViewColumn.One, true);
    } catch (error) {
      this.reportError(this.activeSurface(), error);
    }
  }

  /** Move the active chat tab's session to the sidebar, then close that tab. */
  async openInSidebar(): Promise<void> {
    try {
      const entry = this.activeEntry();
      const controller = entry?.surface.controller;
      if (!entry || !controller) return;
      if (!this.sidebar) await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
      const sidebar = this.sidebar;
      if (!sidebar) return;
      const displaced = this.sidebarController;
      if (displaced && displaced !== controller) {
        displaced.setSlot("background");
        displaced.disposeWhenSettled = displaced.busy;
      }
      this.sidebarController = controller;
      controller.setSlot("sidebar");
      sidebar.bind(controller);
      // The session left this tab; an empty tab standing in its place would be a
      // second thing to close for one "move".
      entry.panel.dispose();
      await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
      if (displaced && displaced !== controller) {
        if (displaced.busy) this.disposeIfSettledHeadless(displaced);
        else this.releaseController(displaced);
      }
    } catch (error) {
      this.reportError(this.sidebar, error);
    }
  }

  /**
   * Move the active chat tab from a floating window back into the editor area
   * (region C → B).
   *
   * VS Code ships no `moveEditorToMainWindow` command and no tab-move API; what
   * it does have is `WebviewPanel.reveal(ViewColumn.One)`, which resolves to the
   * main window's first editor group and moves the panel there without
   * recreating it (verified on 1.134).
   */
  async moveToEditorArea(): Promise<void> {
    const entry = this.activeEntry();
    if (!entry) return;
    entry.panel.reveal(vscode.ViewColumn.One, false);
    entry.region = "editor";
    this.updateMoveMenuContext();
  }

  /** Move the source session into a floating window directly, without an intermediate editor tab. */
  async moveToNewWindow(source: SurfaceKind): Promise<void> {
    if (source === "editor") {
      const entry = this.activeEntry();
      if (!entry) return;
      await this.detachToNewWindow(entry.panel);
      return;
    }
    // Sidebar: VS Code moves only editor tabs between windows — never views —
    // so a carrier editor panel is structurally required. Its stop in this
    // window must be a flash rather than a stay: the panel is created and
    // detached within one breath, and anything slow (the replacement
    // controller for the vacated sidebar) happens only once it is gone.
    try {
      const panel = this.createEditorPanel(vscode.ViewColumn.Active);
      const moved = this.sidebarController;
      if (moved) {
        moved.setSlot("editor");
        this.bindEditorPanel(panel, moved);
      }
      // Detach before building anything: while a controller is being built the
      // carrier tab must not sit in this window's editor area for seconds on end.
      await this.detachToNewWindow(panel);
      if (moved) {
        // The sidebar keeps the moved session's last frame until the fresh
        // controller takes over — the same stale window the previous ordering
        // showed, just without the editor-area stopover.
        await this.refillSurface("sidebar", this.sidebar);
      } else {
        const controller = await this.createController("editor", { mode: "new" });
        this.bindEditorPanel(panel, controller);
      }
    } catch (error) {
      this.reportError(this.activeSurface(), error);
    }
  }

  /**
   * Send one panel to a floating window.
   *
   * `workbench.action.moveEditorToNewWindow` acts on the workbench's *active*
   * editor and takes no argument, so the panel has to be active before the
   * command is issued — otherwise it detaches whatever editor happens to be
   * active instead, i.e. the user's current chat. Carriers are therefore
   * created with `ViewColumn.Active`, so they land wherever the user already
   * is (including a floating window) and are active there without any
   * cross-window focus dance: focus cannot be taken reliably from another
   * window, and the panel would silently stay put.
   */
  private async detachToNewWindow(panel: vscode.WebviewPanel): Promise<void> {
    panel.reveal(panel.viewColumn, false);
    if (!(await waitForPanelActive(panel))) {
      // Refuse rather than detach someone else's editor. The session is live
      // either way; it just stays a tab where it was created.
      this.log("new window: the carrier panel never became active; leaving it in the editor area");
      return;
    }
    await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
    this.markRegion(panel, "window");
  }

  /** Rehydrate an editor panel retained by VS Code across a window reload. */
  async restoreEditorPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    // Serializer callbacks may spend seconds rebuilding the SDK runtime. Paint
    // the webview shell first so a detached window never sits on VS Code's
    // black, uninitialized panel; binding below reloads it once the controller
    // is ready and the normal `ready` handshake can run.
    const surface = this.connectEditorPanel(panel, true);
    try {
      const controller = await this.createController("editor", this.restoredStartup(state));
      surface.bind(controller);
      this.updatePanelTitle(surface);
    } catch (error) {
      this.reportError(surface, error);
    }
  }

  /** A tab reopens its own session; a missing or already claimed file degrades to a new one. */
  private restoredStartup(state: unknown): StartupSession {
    const file = restoredSessionFile(state, this.cwd);
    if (!file || this.claims.owner(file) || !existsSync(file)) return { mode: "new" };
    this.log(`reopening editor tab session: ${file}`);
    return { mode: "file", path: file };
  }

  async newSidebarSession(): Promise<void> {
    try {
      if (!this.sidebarController || !this.sidebar) {
        // The view resolves asynchronously with its own remembered session;
        // asking for a new one in the same breath would race that.
        await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
        return;
      }
      if (this.sidebarController.busy) await this.replaceRunningController(this.sidebar, { mode: "new" });
      else await this.sidebarController.handleMessage({ type: "newSession" });
      await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    } catch (error) {
      this.reportError(this.sidebar, error);
    }
  }

  /** Open a new session in the editor area (a new tab; other tabs are untouched). */
  async newEditorSession(): Promise<void> {
    try {
      const controller = await this.createController("editor", { mode: "new" });
      const panel = this.createEditorPanel();
      this.bindEditorPanel(panel, controller);
      panel.reveal(vscode.ViewColumn.One, true);
    } catch (error) {
      this.reportError(this.activeSurface(), error);
    }
  }

  /** Open a new session in a floating window. */
  async newWindowSession(): Promise<void> {
    try {
      // Build the runtime first, while no carrier panel exists: once the panel
      // is created it must move within the same breath, not wait out the
      // seconds a controller takes as a tab in this window's editor area.
      const controller = await this.createController("editor", { mode: "new" });
      const panel = this.createEditorPanel(vscode.ViewColumn.Active);
      this.bindEditorPanel(panel, controller);
      await this.detachToNewWindow(panel);
    } catch (error) {
      this.reportError(this.activeSurface(), error);
    }
  }

  /** Open an existing session file in a new editor tab from the sessions list. */
  async openSessionInEditor(file: string): Promise<void> {
    try {
      const panel = this.createEditorPanel();
      await this.adoptSessionInPanel(panel, file);
      panel.reveal(vscode.ViewColumn.One, true);
    } catch (error) {
      this.reportError(this.activeSurface(), error);
    }
  }

  /** Open an existing session file in a new floating window. */
  async openSessionInNewWindow(file: string): Promise<void> {
    try {
      const panel = this.createEditorPanel(vscode.ViewColumn.Active);
      await this.adoptSessionInPanel(panel, file);
      await this.detachToNewWindow(panel);
    } catch (error) {
      this.reportError(this.activeSurface(), error);
    }
  }

  /**
   * Fill a freshly created tab with `file`, moving its current owner in rather
   * than constructing a second writer for the same JSONL. A visible source
   * surface is left with a fresh session instead of a stale frame.
   */
  private async adoptSessionInPanel(panel: vscode.WebviewPanel, file: string): Promise<void> {
    const target = this.connectEditorPanel(panel, false);
    const owner = this.claims.owner(file);
    if (owner && !owner.disposed) {
      const source = owner.surface;
      if (source && source !== target) await this.refillSurface(source.kind, source);
      this.moveHeadlessController(owner, target);
      return;
    }
    const controller = await this.createController("editor", { mode: "file", path: file });
    target.bind(controller);
    this.updatePanelTitle(target);
  }

  private createEditorPanel(column = vscode.ViewColumn.One): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      CHAT_PANEL_TYPE,
      "Pi Agent Chat",
      // Default `One`, never `Active`: with a floating window focused, `Active`
      // opens the new chat inside it, which is the opposite of "open in the
      // editor area". Carriers bound for a floating window pass `Active` on
      // purpose — see detachToNewWindow.
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
        enableFindWidget: false,
      },
    );
    this.applyPanelIcon(panel);
    return panel;
  }

  /**
   * Tab icon. Without this the tab falls back to the generic editor glyph, so
   * a chat moved into the editor area or a floating window is indistinguishable
   * from a text file at a glance — which is the one place it competes with
   * other tabs for recognition.
   *
   * Set on restored panels too: `deserializeWebviewPanel` hands back a panel
   * that never went through `createEditorPanel`.
   *
   * Two files rather than the one the activity bar uses: a tab renders this as
   * an `<img>`, so the SVG's own colours are what show up — `currentColor`
   * there resolves against the image document and comes out black on every
   * theme. The `{ light, dark }` form is the platform's answer to that.
   */
  private applyPanelIcon(panel: vscode.WebviewPanel): void {
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, "media", "icon-light.svg"),
      dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "icon-dark.svg"),
    };
  }

  private bindEditorPanel(panel: vscode.WebviewPanel, controller: ChatController): void {
    const surface = this.connectEditorPanel(panel, false);
    surface.bind(controller);
    this.updatePanelTitle(surface);
  }

  /** Establish the panel/webview lifecycle before a runtime is necessarily ready. */
  private connectEditorPanel(panel: vscode.WebviewPanel, renderImmediately: boolean): SurfaceConnection {
    const existing = [...this.panels.values()].find((entry) => entry.panel === panel);
    if (existing) return existing.surface;
    this.applyPanelIcon(panel);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    let surface!: SurfaceConnection;
    surface = new SurfaceConnection(
      "editor",
      panel.webview,
      () => panel.reveal(panel.viewColumn, true),
      (message) => this.handleSurfaceMessage(surface, message),
      () => this.onEditorDisposed(surface),
      () => renderChatHtml(panel.webview, this.context.extensionUri, "editor"),
    );
    const entry: EditorPanelEntry = { panel, surface, region: "editor" };
    this.panels.set(surface, entry);
    if (panel.active) this.activePanel = entry;
    panel.onDidDispose(() => surface.dispose());
    panel.onDidChangeViewState(() => {
      // The first editor group of the main window is the one column a floating
      // window can never own, so it is the one reliable correction to the
      // region bookkeeping when the user drags tabs around by hand.
      if (panel.viewColumn === vscode.ViewColumn.One) entry.region = "editor";
      if (panel.active) this.activePanel = entry;
      this.updateMoveMenuContext();
    });
    if (renderImmediately) surface.render();
    this.updateMoveMenuContext();
    return surface;
  }

  private markRegion(panel: vscode.WebviewPanel, region: PanelRegion): void {
    const entry = [...this.panels.values()].find((candidate) => candidate.panel === panel);
    if (!entry) return;
    entry.region = region;
    this.updateMoveMenuContext();
  }

  /**
   * The tab a title-bar command applies to.
   *
   * `WebviewPanel.active` is true for at most one panel — the workbench's active
   * editor — which is the same fact VS Code evaluates `activeWebviewPanelId`
   * against, so reading it live keeps the command and the menu that offered it
   * on the same tab. The tracked value only covers the gap where focus has
   * moved off the editor area entirely (a menu click can do that).
   */
  private activeEntry(): EditorPanelEntry | undefined {
    const entries = [...this.panels.values()];
    const live = entries.find((entry) => entry.panel.active);
    if (live) return live;
    if (this.activePanel && this.panels.has(this.activePanel.surface)) return this.activePanel;
    return entries.length === 1 ? entries[0] : undefined;
  }

  private activeSurface(): SurfaceConnection | undefined {
    return this.activeEntry()?.surface ?? this.sidebar;
  }

  private async handleSurfaceMessage(surface: SurfaceConnection, message: WebviewMessage): Promise<void> {
    try {
      const controller = surface.controller;
      let effectiveMessage = message;
      if (message.type === "revealSession" && controller) {
        if (await this.moveClaimedSession(controller, surface, message.file)) {
          await this.revealLaneAfterMove(surface, message.file);
          return;
        }
        // The owner may have released its claim after the list was rendered.
        // Fall through to an ordinary live resume instead of turning a stale
        // row into a no-op.
        effectiveMessage = { type: "resumeSession", file: message.file };
      }
      const replacement = replacementStartupForRunningController(
        effectiveMessage,
        Boolean(controller?.busy),
        controller?.claimedFile,
      );
      if (replacement) {
        // An existing owner wins before construction. Session-list navigation
        // is handled above; other switch paths reveal the owner instead of
        // opening a second writer for the same JSONL file.
        if (replacement.mode === "file" && controller && this.redirectClaimedSession(controller, replacement.path)) return;
        await this.replaceRunningController(surface, replacement);
        return;
      }
      if (effectiveMessage.type === "openSessionInEditor") {
        await this.openSessionInEditor(effectiveMessage.file);
      } else if (effectiveMessage.type === "openSessionInNewWindow") {
        await this.openSessionInNewWindow(effectiveMessage.file);
      } else {
        await controller?.handleMessage(effectiveMessage);
      }
    } catch (error) {
      this.reportError(surface, error);
    }
  }

  /**
   * Replacing the visible session is local to the surface where it was
   * requested. A running controller is detached, not aborted: it keeps its
   * claim and event subscription until it settles, while a new or explicitly
   * selected session takes over the same webview.
   */
  private async replaceRunningController(surface: SurfaceConnection, startup: StartupSession): Promise<void> {
    const running = surface.controller;
    if (!running || !running.busy) return;
    const replacement = await this.createController(surface.kind, startup);
    running.setSlot("background");
    running.disposeWhenSettled = true;
    if (surface.kind === "sidebar") this.sidebarController = replacement;
    surface.bind(replacement);
    this.updatePanelTitle(surface);
    this.disposeIfSettledHeadless(running);
  }

  private onSidebarDisposed(surface: SurfaceConnection): void {
    if (this.sidebar !== surface) return;
    this.sidebar = undefined;
    surface.controller?.detach(surface);
  }

  private onEditorDisposed(surface: SurfaceConnection): void {
    const entry = this.panels.get(surface);
    if (!entry) return;
    this.panels.delete(surface);
    if (this.activePanel === entry) this.activePanel = undefined;
    const controller = surface.controller;
    controller?.detach(surface);
    if (controller) {
      controller.setSlot("background");
      controller.disposeWhenSettled = true;
    }
    this.disposeIfSettledHeadless(controller);
    this.updateMoveMenuContext();
  }

  /**
   * Leave a surface whose controller went somewhere else with a fresh session.
   *
   * One rule in one place: whoever hands a controller away also has to answer
   * "what does the vacated surface show now?", and the sidebar's controller is
   * tracked even while no view is bound (it can be closed), so that bookkeeping
   * follows the kind rather than the connection.
   */
  private async refillSurface(kind: SurfaceKind, surface: SurfaceConnection | undefined): Promise<void> {
    const replacement = await this.createController(kind, { mode: "new" });
    if (kind === "sidebar") this.sidebarController = replacement;
    surface?.bind(replacement);
  }

  private createController(slot: SurfaceKind, requestedStartup: StartupSession): Promise<ChatController> {
    const creation = this.creationQueue.then(async () => {
      // Sidebar resolve and panel restore can race during activation. Re-check a
      // remembered file only after earlier controller creation has published
      // its claim; otherwise both factories could open the same JSONL.
      const startup = (requestedStartup.mode === "file" && this.claims.owner(requestedStartup.path))
        || (requestedStartup.mode === "recent" && this.controllers.size > 0)
        ? { mode: "new" } as const
        : requestedStartup;
      const controller = new ChatController(`chat-${this.nextControllerId++}`, slot, this);
      this.controllers.add(controller);
      try {
        const sharedServices = [...this.controllers]
          .find((candidate) => candidate !== controller && !candidate.disposed && candidate.services)?.services;
        await controller.start(startup, sharedServices);
        if (controller.claimConflict) {
          this.log(`startup session already belongs to another surface; ${slot} starts a new session instead`);
          controller.claimConflict = false;
          await controller.handleMessage({ type: "newSession" });
        }
        return controller;
      } catch (error) {
        this.controllers.delete(controller);
        controller.dispose();
        throw error;
      }
    });
    this.creationQueue = creation.then(() => undefined, () => undefined);
    return creation;
  }

  private startupSession(slot: SurfaceKind): StartupSession {
    // Only the sidebar has a window-level memory slot: editor tabs each carry
    // their own in webview state (see restoredSessionFile).
    if (slot !== "sidebar") return { mode: "new" };
    const stored = this.context.workspaceState.get<LastSession>(SIDEBAR_LAST_SESSION_KEY)
      ?? this.context.workspaceState.get<LastSession>(LEGACY_LAST_SESSION_KEY);
    if (!stored || stored.cwd !== this.cwd) return { mode: "recent" };
    if (typeof stored.file !== "string" || stored.file.length === 0) return { mode: "new" };
    if (this.claims.owner(stored.file)) return { mode: "new" };
    this.log(`reopening ${slot} session: ${stored.file}`);
    return { mode: "file", path: stored.file };
  }

  remember(controller: ChatController, file: string | undefined): void {
    controller.rememberedFile = file;
    this.updateControllerClaim(controller, file);
    if (controller.slot !== "sidebar") return;
    const stored: LastSession = { cwd: this.cwd, file: file ?? null };
    void Promise.resolve(this.context.workspaceState.update(SIDEBAR_LAST_SESSION_KEY, stored)).then(
      undefined,
      (error) => this.log(`failed to remember the ${controller.slot} session: ${describeWithStack(error).split("\n")[0]}`),
    );
  }

  /**
   * The controller's own session file changed (a switch, a new session, or the
   * first append giving an in-memory session a file). The lanes are re-read at
   * the same time so both halves of ownership always land together.
   */
  private updateControllerClaim(controller: ChatController, next: string | undefined): void {
    controller.claimedFile = next;
    this.updateControllerClaims(controller);
  }

  onControllerState(controller: ChatController): void {
    // Deliberately without the posted `ChatState`: ownership follows what this
    // controller's runtime *writes*, never what its webview displays. Claiming
    // `state.sessionFile` used to hand this controller's own file away the
    // moment a subagent transcript went on screen — after which a second
    // controller could resume that live session, and every session list showed
    // the task line as ordinary rows.
    this.updateControllerClaims(controller);
    if (controller.surface) this.updatePanelTitle(controller.surface);
    this.notifySessionsChanged();
    this.disposeIfSettledHeadless(controller);
  }

  /**
   * Publish this controller's ownership: its own session file plus the files
   * its running subagents append to, releasing everything it no longer writes.
   *
   * A running lane appends to its JSONL exactly like a top-level session does,
   * so it needs the same exclusion — otherwise another surface can resume a
   * subagent's file and produce a second writer for it.
   */
  private updateControllerClaims(controller: ChatController): void {
    const owned = new Set(ownedSessionFiles({
      sessionFile: controller.claimedFile,
      runningLaneFiles: controller.laneSessionFiles(),
    }));
    for (const file of [...controller.claimedFiles]) {
      if (owned.has(file)) continue;
      this.claims.release(file, controller);
      controller.claimedFiles.delete(file);
    }
    controller.claimConflict = false;
    for (const file of owned) {
      if (controller.claimedFiles.has(file)) continue;
      if (this.claims.claim(file, controller)) {
        controller.claimedFiles.add(file);
        continue;
      }
      const owner = this.claims.owner(file);
      this.log(`session claim collision refused: ${file} (${owner?.id ?? "unknown"} already owns it)`);
      // Only the controller's own session can be started over; a lane file
      // owned elsewhere is a bug in someone else's bookkeeping, not a reason to
      // throw away this session.
      if (file === controller.claimedFile) controller.claimConflict = true;
    }
  }

  /** Task-line role of a session file in this window, whichever controller runs it. */
  delegationRoleAt(file: string): "parent" | "child" | undefined {
    for (const controller of this.controllers) {
      if (controller.disposed) continue;
      const role = controller.delegationRoleAt(file);
      if (role) return role;
    }
    return undefined;
  }

  notifySessionsChanged(): void {
    if (this.disposed) return;
    this.updateMoveMenuContext();
    this.sessionsChangedEmitter.fire();
  }

  /**
   * Keep the "move this session" menu items in step with the sessions the two
   * surfaces actually hold (`when: !piAgentChat.<slot>SessionEmpty` in the
   * manifest). An empty session is not offered for moving — every target
   * surface already has an "open a new session in …" item that amounts to the
   * same thing.
   *
   * Called from notifySessionsChanged() so that every path which changes which
   * controller sits on which surface (a state post, a swap, a move, a
   * release) converges here; VS Code re-evaluates the menu `when` clauses as
   * soon as the context value lands.
   */
  private updateMoveMenuContext(): void {
    const sidebarEmpty = !isMovableSessionState(this.sidebarController?.state);
    const active = this.activeEntry();
    const tabEmpty = !isMovableSessionState(active?.surface.controller?.state);
    const tabRegion = active?.region ?? "editor";
    // This runs on every state post; only an actual flip should reach VS Code.
    if (this.moveMenuContext?.sidebarEmpty === sidebarEmpty
      && this.moveMenuContext.tabEmpty === tabEmpty
      && this.moveMenuContext.tabRegion === tabRegion) return;
    this.moveMenuContext = { sidebarEmpty, tabEmpty, tabRegion };
    void vscode.commands.executeCommand("setContext", "piAgentChat.sidebarSessionEmpty", sidebarEmpty);
    void vscode.commands.executeCommand("setContext", "piAgentChat.chatTabSessionEmpty", tabEmpty);
    void vscode.commands.executeCommand("setContext", "piAgentChat.chatTabRegion", tabRegion);
  }

  redirectClaimedSession(requester: ChatController, file: string): boolean {
    const owner = this.claims.owner(file);
    if (!owner || owner === requester || owner.disposed) return false;
    if (owner.surface) owner.surface.reveal();
    else if (requester.surface) this.moveHeadlessController(owner, requester.surface);
    return true;
  }

  /**
   * Session-list navigation is spatial: the selected controller moves to the
   * surface where the click happened. If it came from the peer surface, that
   * source immediately receives a fresh empty controller; the target's former
   * controller is retained headlessly only while it is busy.
   */
  private async moveClaimedSession(
    requester: ChatController,
    target: SurfaceConnection,
    file: string,
  ): Promise<boolean> {
    const owner = this.claims.owner(file);
    if (!owner || owner === requester || owner.disposed) return false;
    const source = owner.surface;
    const sourceStartup = claimedSessionSourceStartup(source ? "visible" : "background");
    if (source && source !== target && sourceStartup) {
      const replacement = await this.createController(source.kind, sourceStartup);
      if (source.kind === "sidebar") this.sidebarController = replacement;
      source.bind(replacement);
      this.updatePanelTitle(source);
    }
    this.moveHeadlessController(owner, target);
    return true;
  }

  claimedSessionLocation(requester: ChatController, file: string): "visible" | "background" | undefined {
    const owner = this.claims.owner(file);
    if (!owner || owner === requester || owner.disposed) return undefined;
    return owner.surface ? "visible" : "background";
  }

  /**
   * A lane row addresses the controller that runs it, because the file belongs
   * to a subagent rather than to a session anyone may open. Once that
   * controller has moved to the requesting surface, land on the lane the user
   * actually clicked instead of on the parent transcript.
   */
  private async revealLaneAfterMove(surface: SurfaceConnection, file: string): Promise<void> {
    const moved = surface.controller;
    if (!moved || moved.delegationRoleAt(file) !== "child") return;
    await moved.handleMessage({ type: "showLane", sessionFile: file });
  }

  /** Bring a claimed background run into the requesting surface without a second writer. */
  private moveHeadlessController(controller: ChatController, target: SurfaceConnection): void {
    const displaced = target.controller;
    if (controller === this.sidebarController) this.sidebarController = undefined;
    if (displaced && displaced !== controller) {
      displaced.setSlot("background");
      displaced.disposeWhenSettled = displaced.busy;
    }
    if (target.kind === "sidebar") this.sidebarController = controller;
    controller.setSlot(target.kind);
    target.bind(controller);
    this.updatePanelTitle(target);
    if (displaced && displaced !== controller) {
      if (displaced.busy) this.disposeIfSettledHeadless(displaced);
      else this.releaseController(displaced);
    }
    target.reveal();
  }

  private disposeIfSettledHeadless(controller: ChatController | undefined): void {
    if (!controller || controller.disposed || !shouldDisposeHeadlessRuntime({
      disposeWhenSettled: controller.disposeWhenSettled,
      visible: Boolean(controller.surface),
      busy: controller.busy,
      retainedSidebar: controller === this.sidebarController,
    })) return;
    // State posts happen inside the SDK event stack. Dispose after it unwinds so
    // extension shutdown cannot invalidate the runner that is still settling.
    queueMicrotask(() => {
      if (controller.disposed || !shouldDisposeHeadlessRuntime({
        disposeWhenSettled: controller.disposeWhenSettled,
        visible: Boolean(controller.surface),
        busy: controller.busy,
        retainedSidebar: controller === this.sidebarController,
      })) return;
      this.releaseController(controller);
    });
  }

  private releaseController(controller: ChatController): void {
    for (const file of controller.claimedFiles) this.claims.release(file, controller);
    controller.claimedFiles.clear();
    controller.claimedFile = undefined;
    this.controllers.delete(controller);
    controller.dispose();
    this.notifySessionsChanged();
  }


  private updatePanelTitle(surface: SurfaceConnection | undefined): void {
    const entry = surface ? this.panels.get(surface) : undefined;
    if (!entry) return;
    entry.panel.title = editorPanelTitle(surface?.controller?.state?.sessionName);
  }

  private reportError(surface: SurfaceConnection | undefined, error: unknown): void {
    const message = describeWithStack(error);
    this.log(`error: ${message}`);
    surface?.post({
      type: "state",
      state: { ready: false, isStreaming: false, isCompacting: false, error: message.split("\n")[0] },
    });
    void vscode.window.showErrorMessage(`Pi Agent Chat: ${message.split("\n")[0]}`);
  }

  log(message: string): void {
    this.output.appendLine(message);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sidebar?.dispose();
    for (const entry of [...this.panels.values()]) entry.surface.dispose();
    for (const controller of [...this.controllers]) this.releaseController(controller);
    this.sessionsChangedEmitter.dispose();
  }
}

class ChatController implements vscode.Disposable {
  runtime?: PiRuntime;
  bridge?: ChatBridge;
  state?: ChatState;
  surface?: SurfaceConnection;
  rememberedFile?: string;
  /** Its own session file: the one a startup or a session switch addresses. */
  claimedFile?: string;
  /** Everything it currently claims: `claimedFile` plus its running lanes. */
  readonly claimedFiles = new Set<string>();
  claimConflict = false;
  disposed = false;
  disposeWhenSettled = false;
  private starting?: Promise<void>;

  constructor(
    readonly id: string,
    public slot: ControllerSlot,
    private readonly owner: ChatSurfaceManager,
  ) {}

  get services(): AgentSessionServices | undefined {
    return this.runtime?.runtime.services;
  }

  get busy(): boolean {
    const session = this.runtime?.session;
    return Boolean(session?.isStreaming || session?.isCompacting);
  }

  /** Session files this controller's subagents are appending to right now. */
  laneSessionFiles(): string[] {
    return this.bridge?.runningLaneFiles() ?? [];
  }

  /** Task-line role of a session file in this controller's run, if any. */
  delegationRoleAt(file: string): "parent" | "child" | undefined {
    return this.bridge?.delegationRoleAt(file);
  }

  async start(startup: StartupSession, sharedServices?: AgentSessionServices): Promise<void> {
    this.starting ??= this.initialize(startup, sharedServices);
    await this.starting;
  }

  private async initialize(startup: StartupSession, sharedServices?: AgentSessionServices): Promise<void> {
    this.owner.log(`starting ${this.slot} pi runtime in ${this.owner.cwd}`);
    const runtime = await PiRuntime.create({
      cwd: this.owner.cwd,
      startup,
      sharedServices,
      log: (message) => this.owner.log(`[${this.id}] ${message}`),
      redirectClaimedSession: (file) => this.owner.redirectClaimedSession(this, file),
    });
    const bridge = new ChatBridge(
      runtime,
      {
        post: (message) => this.post(message),
        log: (message) => this.owner.log(`[${this.id}] ${message}`),
        rememberSession: (file) => this.owner.remember(this, file),
        revealClaimedSession: (file) => this.owner.redirectClaimedSession(this, file),
        claimedSessionLocation: (file) => this.owner.claimedSessionLocation(this, file),
        delegationRoleAt: (file) => this.owner.delegationRoleAt(file),
        notifySessionsChanged: () => this.owner.notifySessionsChanged(),
        onDidChangeSessions: this.owner.onDidChangeSessions,
      },
      this.owner.diffProvider,
    );
    this.runtime = runtime;
    this.bridge = bridge;
    await bridge.attach();
    this.owner.log(`${this.slot} session ready: ${runtime.session.sessionFile ?? "(in-memory)"}`);
  }

  setSlot(slot: ControllerSlot): void {
    this.slot = slot;
    if (slot !== "background") this.owner.remember(this, this.rememberedFile);
    this.owner.notifySessionsChanged();
  }

  attach(surface: SurfaceConnection): void {
    if (this.surface && this.surface !== surface) this.surface.clearController(this);
    this.surface = surface;
    this.disposeWhenSettled = false;
  }

  detach(surface: SurfaceConnection): void {
    if (this.surface === surface) this.surface = undefined;
  }

  async handleMessage(message: WebviewMessage): Promise<void> {
    await this.starting;
    await this.bridge?.handleMessage(message);
  }

  private post(message: HostMessage): void {
    if (message.type === "state") {
      this.state = message.state;
      this.owner.onControllerState(this);
    }
    this.surface?.post(message);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bridge?.dispose();
    this.runtime?.dispose();
    this.surface?.clearController(this);
    this.surface = undefined;
  }
}

class SurfaceConnection implements vscode.Disposable {
  controller?: ChatController;
  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;

  constructor(
    readonly kind: SurfaceKind,
    private readonly webview: vscode.Webview,
    readonly reveal: () => void,
    onMessage: (message: WebviewMessage) => void,
    private readonly onDispose: () => void,
    private readonly html: () => string,
  ) {
    this.subscriptions.push(this.webview.onDidReceiveMessage(onMessage));
  }

  bind(controller: ChatController): void {
    if (this.controller === controller) {
      this.render();
      return;
    }
    this.controller?.detach(this);
    this.controller = controller;
    controller.attach(this);
    this.render();
  }

  render(): void {
    if (!this.disposed) this.webview.html = this.html();
  }

  clearController(controller: ChatController): void {
    if (this.controller === controller) this.controller = undefined;
  }

  post(message: HostMessage): void {
    if (!this.disposed) void this.webview.postMessage(message);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.onDispose();
  }
}

/**
 * Resolve once a panel is the workbench's active editor; `false` on timeout.
 *
 * Bounded because activation can legitimately never arrive (another window
 * holds focus), and callers must be able to tell that apart from success.
 */
function waitForPanelActive(panel: vscode.WebviewPanel, timeoutMs = 800): Promise<boolean> {
  if (panel.active) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (active: boolean): void => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(active);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const subscription = panel.onDidChangeViewState(() => {
      if (panel.active) finish(true);
    });
  });
}

/** Keep a lone editor tab compact too; VS Code only elides titles when tabs compete for space. */export function editorPanelTitle(sessionName: string | undefined): string {
  const title = sessionName ? `${sessionName} — Pi` : "Pi Agent Chat";
  const characters = [...title];
  if (characters.length <= MAX_EDITOR_TAB_TITLE_CHARS) return title;
  return `${characters.slice(0, MAX_EDITOR_TAB_TITLE_CHARS - 3).join("")}...`;
}

function sessionKey(file: string): string {
  const normalized = vscode.Uri.file(file).fsPath;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function renderChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri, surface: SurfaceKind): string {
  const asset = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts));
  const scriptUri = asset("dist", "webview.js");
  const styleUri = asset("dist", "main.css");
  const nonce = createNonce();
  return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>Pi Agent Chat</title>
  </head>
  <body class="surface-${surface}">
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i += 1) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
