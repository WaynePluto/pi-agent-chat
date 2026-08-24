import * as vscode from "vscode";
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
const LAST_SESSION_KEYS = {
  sidebar: "piAgentChat.lastSession.sidebar",
  editor: "piAgentChat.lastSession.editor",
} as const;

type SurfaceKind = keyof typeof LAST_SESSION_KEYS;
type ControllerSlot = SurfaceKind | "background";
interface LastSession {
  cwd: string;
  file: string | null;
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
  private panel?: vscode.WebviewPanel;
  private editor?: SurfaceConnection;
  private sidebarController?: ChatController;
  private editorController?: ChatController;
  private readonly controllers = new Set<ChatController>();
  private readonly claims = new SessionClaimRegistry<ChatController>();
  private readonly sessionsChangedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeSessions = this.sessionsChangedEmitter.event;
  private nextControllerId = 1;
  private creationQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  /** Last context values pushed for the move-menu `when` clauses; see updateMoveMenuContext. */
  private moveMenuContext?: { sidebarEmpty: boolean; editorEmpty: boolean };

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

  /** Move the sidebar's current controller into a singleton editor tab. */
  async openEditor(): Promise<void> {
    if (this.panel) {
      this.swapVisibleControllers();
      this.panel.reveal(this.panel.viewColumn, true);
      return;
    }
    if (this.editorController) {
      this.bindEditorPanel(this.createEditorPanel(), this.editorController);
      return;
    }

    try {
      const panel = this.createEditorPanel();
      if (this.sidebarController) {
        const moved = this.sidebarController;
        this.editorController = moved;
        moved.setSlot("editor");
        this.bindEditorPanel(panel, moved);

        const replacement = await this.createController("sidebar", { mode: "new" });
        this.sidebarController = replacement;
        if (this.sidebar) this.sidebar.bind(replacement);
      } else {
        const controller = await this.createController("editor", this.startupSession("editor"));
        this.editorController = controller;
        this.bindEditorPanel(panel, controller);
      }
    } catch (error) {
      this.reportError(this.editor ?? this.sidebar, error);
    }
  }

  /** Move the editor chat to the sidebar, then close its original editor tab. */
  async openInSidebar(): Promise<void> {
    if (!this.sidebar) await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    const moved = this.swapVisibleControllers();
    await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    if (moved) this.panel?.dispose();
  }

  /** Move the source session into a floating window directly, without an intermediate editor tab. */
  async moveToNewWindow(source: SurfaceKind): Promise<void> {
    if (source === "editor") {
      // The panel already is an editor tab; just detach it.
      const panel = this.panel;
      if (!panel) return;
      panel.reveal(panel.viewColumn, false);
      await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
      return;
    }
    // Sidebar: VS Code moves only editor tabs between windows — never views —
    // so a carrier editor panel is structurally required. Its stop in this
    // window must be a flash rather than a stay: the panel is created and
    // detached within one breath, and anything slow (the replacement
    // controller for the vacated sidebar) happens only once it is gone.
    try {
      if (this.panel) {
        // An editor chat already exists: hand the sidebar's session to that
        // panel (its own controller takes the vacated sidebar), then detach it.
        this.swapVisibleControllers();
        this.panel.reveal(this.panel.viewColumn, false);
        await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
        return;
      }
      const panel = this.createEditorPanel();
      const moved = this.sidebarController;
      if (moved) {
        this.editorController = moved;
        moved.setSlot("editor");
        this.bindEditorPanel(panel, moved);
      }
      // Detach before any await: while a controller is being built the carrier
      // tab must not sit in this window's editor area for seconds on end.
      panel.reveal(panel.viewColumn, false);
      await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
      if (moved) {
        // The sidebar keeps the moved session's last frame until the fresh
        // controller takes over — the same stale window the previous ordering
        // showed, just without the editor-area stopover.
        const replacement = await this.createController("sidebar", { mode: "new" });
        this.sidebarController = replacement;
        if (this.sidebar) this.sidebar.bind(replacement);
      } else {
        const controller = await this.createController("editor", this.startupSession("editor"));
        this.editorController = controller;
        this.bindEditorPanel(panel, controller);
      }
    } catch (error) {
      this.reportError(this.editor ?? this.sidebar, error);
    }
  }

  private swapVisibleControllers(): boolean {
    const sidebar = this.sidebarController;
    const editor = this.editorController;
    if (!sidebar || !editor || !this.sidebar || !this.editor || sidebar === editor) return false;
    this.sidebarController = editor;
    this.editorController = sidebar;
    editor.setSlot("sidebar");
    sidebar.setSlot("editor");
    this.sidebar.bind(editor);
    this.editor.bind(sidebar);
    this.updatePanelTitle(sidebar.state);
    return true;
  }

  /** Rehydrate an editor panel retained by VS Code across a window reload. */
  async restoreEditorPanel(panel: vscode.WebviewPanel): Promise<void> {
    // Serializer callbacks may spend seconds rebuilding the SDK runtime. Paint
    // the webview shell first so a detached window never sits on VS Code's
    // black, uninitialized panel; binding below reloads it once the controller
    // is ready and the normal `ready` handshake can run.
    const surface = this.connectEditorPanel(panel, true);
    try {
      const controller = this.editorController ?? await this.createController("editor", this.startupSession("editor"));
      this.editorController = controller;
      surface.bind(controller);
      this.updatePanelTitle(controller.state);
    } catch (error) {
      this.reportError(surface, error);
    }
  }

  async newSidebarSession(): Promise<void> {
    try {
      if (!this.sidebarController || !this.sidebar) {
        await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
        return;
      }
      if (this.sidebarController.busy) await this.replaceRunningController(this.sidebar, { mode: "new" });
      else await this.sidebarController.handleMessage({ type: "newSession" });
    } catch (error) {
      this.reportError(this.sidebar, error);
    }
  }

  /** Open a new session in the editor area (does not move the sidebar session). */
  async newEditorSession(): Promise<void> {
    try {
      const panel = this.panel ?? this.createEditorPanel();
      if (this.editorController && !this.panel) {
        // Headless controller: create a panel for it first, then start new.
        this.bindEditorPanel(panel, this.editorController);
      }
      if (!this.panel) {
        // First editor: create a fresh controller.
        const controller = await this.createController("editor", { mode: "new" });
        this.editorController = controller;
        this.bindEditorPanel(panel, controller);
      } else if (this.editorController) {
        if (this.editorController.busy) await this.replaceRunningController(this.editor!, { mode: "new" });
        else await this.editorController.handleMessage({ type: "newSession" });
      }
      panel.reveal(panel.viewColumn, true);
    } catch (error) {
      this.reportError(this.editor ?? this.sidebar, error);
    }
  }

  /** Open a new session in a floating window. */
  async newWindowSession(): Promise<void> {
    try {
      // Build the runtime first, while no carrier panel exists: once the panel
      // is created it must move within the same breath, not wait out the
      // seconds a controller takes as a tab in this window's editor area.
      const controller = await this.createController("editor", { mode: "new" });
      this.editorController = controller;
      const panel = this.createEditorPanel();
      this.bindEditorPanel(panel, controller);
      panel.reveal(panel.viewColumn, false);
      await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
    } catch (error) {
      this.reportError(this.editor ?? this.sidebar, error);
    }
  }

  private createEditorPanel(): vscode.WebviewPanel {
    return vscode.window.createWebviewPanel(
      CHAT_PANEL_TYPE,
      "Pi Agent Chat",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
        enableFindWidget: false,
      },
    );
  }

  private bindEditorPanel(panel: vscode.WebviewPanel, controller: ChatController): void {
    const surface = this.connectEditorPanel(panel, false);
    surface.bind(controller);
    this.updatePanelTitle(controller.state);
  }

  /** Establish the panel/webview lifecycle before a runtime is necessarily ready. */
  private connectEditorPanel(panel: vscode.WebviewPanel, renderImmediately: boolean): SurfaceConnection {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    this.panel = panel;
    let surface!: SurfaceConnection;
    surface = new SurfaceConnection(
      "editor",
      panel.webview,
      () => panel.reveal(panel.viewColumn, true),
      (message) => this.handleSurfaceMessage(surface, message),
      () => this.onEditorDisposed(surface),
      () => renderChatHtml(panel.webview, this.context.extensionUri, "editor"),
    );
    this.editor = surface;
    panel.onDidDispose(() => surface.dispose());
    if (renderImmediately) surface.render();
    return surface;
  }

  private async handleSurfaceMessage(surface: SurfaceConnection, message: WebviewMessage): Promise<void> {
    try {
      const controller = surface.controller;
      let effectiveMessage = message;
      if (message.type === "revealSession" && controller) {
        if (await this.moveClaimedSession(controller, surface, message.file)) return;
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
      await controller?.handleMessage(effectiveMessage);
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
    else this.editorController = replacement;
    surface.bind(replacement);
    if (surface.kind === "editor") this.updatePanelTitle(replacement.state);
    this.disposeIfSettledHeadless(running);
  }

  private onSidebarDisposed(surface: SurfaceConnection): void {
    if (this.sidebar !== surface) return;
    this.sidebar = undefined;
    surface.controller?.detach(surface);
  }

  private onEditorDisposed(surface: SurfaceConnection): void {
    if (this.editor !== surface) return;
    this.editor = undefined;
    this.panel = undefined;
    const controller = surface.controller;
    controller?.detach(surface);
    if (controller) {
      if (this.editorController === controller) this.editorController = undefined;
      controller.setSlot("background");
      controller.disposeWhenSettled = true;
    }
    this.disposeIfSettledHeadless(controller);
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
    const stored = this.context.workspaceState.get<LastSession>(LAST_SESSION_KEYS[slot])
      ?? (slot === "sidebar" ? this.context.workspaceState.get<LastSession>(LEGACY_LAST_SESSION_KEY) : undefined);
    if (!stored || stored.cwd !== this.cwd) return slot === "sidebar" ? { mode: "recent" } : { mode: "new" };
    if (typeof stored.file !== "string" || stored.file.length === 0) return { mode: "new" };
    if (this.claims.owner(stored.file)) return { mode: "new" };
    this.log(`reopening ${slot} session: ${stored.file}`);
    return { mode: "file", path: stored.file };
  }

  remember(controller: ChatController, file: string | undefined): void {
    controller.rememberedFile = file;
    this.updateControllerClaim(controller, file);
    if (controller.slot === "background") return;
    const stored: LastSession = { cwd: this.cwd, file: file ?? null };
    void Promise.resolve(this.context.workspaceState.update(LAST_SESSION_KEYS[controller.slot], stored)).then(
      undefined,
      (error) => this.log(`failed to remember the ${controller.slot} session: ${describeWithStack(error).split("\n")[0]}`),
    );
  }

  private updateControllerClaim(controller: ChatController, next: string | undefined): void {
    const previous = controller.claimedFile;
    if (previous && previous !== next) this.claims.release(previous, controller);
    controller.claimedFile = next;
    if (next && !this.claims.claim(next, controller)) {
      controller.claimConflict = true;
      const owner = this.claims.owner(next);
      this.log(`session claim collision refused: ${next} (${owner?.id ?? "unknown"} already owns it)`);
    } else {
      controller.claimConflict = false;
    }
  }

  onControllerState(controller: ChatController, state: ChatState): void {
    this.updateControllerClaim(controller, state.sessionFile);
    if (controller === this.editorController) this.updatePanelTitle(state);
    this.notifySessionsChanged();
    this.disposeIfSettledHeadless(controller);
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
    const editorEmpty = !isMovableSessionState(this.editorController?.state);
    // This runs on every state post; only an actual flip should reach VS Code.
    if (this.moveMenuContext?.sidebarEmpty === sidebarEmpty && this.moveMenuContext.editorEmpty === editorEmpty) return;
    this.moveMenuContext = { sidebarEmpty, editorEmpty };
    void vscode.commands.executeCommand("setContext", "piAgentChat.sidebarSessionEmpty", sidebarEmpty);
    void vscode.commands.executeCommand("setContext", "piAgentChat.editorSessionEmpty", editorEmpty);
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
      else this.editorController = replacement;
      source.bind(replacement);
      if (source.kind === "editor") this.updatePanelTitle(replacement.state);
    }
    this.moveHeadlessController(owner, target);
    return true;
  }

  claimedSessionLocation(requester: ChatController, file: string): "visible" | "background" | undefined {
    const owner = this.claims.owner(file);
    if (!owner || owner === requester || owner.disposed) return undefined;
    return owner.surface ? "visible" : "background";
  }

  /** Bring a claimed background run into the requesting surface without a second writer. */
  private moveHeadlessController(controller: ChatController, target: SurfaceConnection): void {
    const displaced = target.controller;
    if (controller === this.sidebarController) this.sidebarController = undefined;
    if (controller === this.editorController) this.editorController = undefined;
    if (displaced && displaced !== controller) {
      displaced.setSlot("background");
      displaced.disposeWhenSettled = displaced.busy;
    }
    if (target.kind === "sidebar") this.sidebarController = controller;
    else this.editorController = controller;
    controller.setSlot(target.kind);
    target.bind(controller);
    if (target.kind === "editor") this.updatePanelTitle(controller.state);
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
      if (controller === this.editorController) this.editorController = undefined;
      this.releaseController(controller);
    });
  }

  private releaseController(controller: ChatController): void {
    if (controller.claimedFile) this.claims.release(controller.claimedFile, controller);
    this.controllers.delete(controller);
    controller.dispose();
    this.notifySessionsChanged();
  }


  private updatePanelTitle(state: ChatState | undefined): void {
    if (!this.panel) return;
    this.panel.title = editorPanelTitle(state?.sessionName);
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
    this.editor?.dispose();
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
  claimedFile?: string;
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
      this.owner.onControllerState(this, message.state);
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

/** Keep a lone editor tab compact too; VS Code only elides titles when tabs compete for space. */
export function editorPanelTitle(sessionName: string | undefined): string {
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
