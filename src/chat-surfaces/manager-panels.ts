import * as vscode from "vscode";
import type { OriginalContentProvider } from "../agent/diff-view.js";
import { describeWithStack } from "../agent/errors.js";
import type { StartupSession } from "../agent/runtime.js";
import type { WebviewMessage } from "../shared/protocol.js";
import { SessionClaimRegistry } from "./claims.js";
import type { ChatController } from "./controller.js";
import { renderChatHtml } from "./html.js";
import { editorPanelTitle, isMovableSessionState } from "./rules.js";
import { SurfaceConnection } from "./surface-connection.js";
import { CHAT_PANEL_TYPE, CHAT_VIEW_ID, type EditorPanelEntry, type PanelRegion, type SurfaceKind } from "./types.js";

/**
 * 顶层聊天管理的 surface 与 panel 生命周期一半：侧边栏 resolve、编辑区
 * panel 的创建与连接、区域记账、移动菜单的 `when` 上下文、错误上报与销毁。
 * controller 级动作与会话 claim 簿记在子类 `ChatSurfaceManager`
 * （`manager.ts`）。
 */
export abstract class ChatSurfaceManagerPanels implements vscode.Disposable {
  protected sidebar?: SurfaceConnection;
  protected sidebarController?: ChatController;
  /** 本窗口所有聊天 tab（两个区域都算），按其 surface 索引。 */
  private readonly panels = new Map<SurfaceConnection, EditorPanelEntry>();
  /** 标题栏命令作用的 tab；VS Code 按活动编辑器评估这些菜单。 */
  private activePanel?: EditorPanelEntry;
  protected readonly controllers = new Set<ChatController>();
  protected readonly claims = new SessionClaimRegistry<ChatController>();
  private readonly sessionsChangedEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeSessions = this.sessionsChangedEmitter.event;
  protected nextControllerId = 1;
  protected creationQueue: Promise<void> = Promise.resolve();
  private disposed = false;
  /** 最近为移动菜单 `when` 子句推送的上下文值；见 updateMoveMenuContext。 */
  private moveMenuContext?: { sidebarEmpty: boolean; tabEmpty: boolean; tabRegion: PanelRegion };

  constructor(
    protected readonly context: vscode.ExtensionContext,
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

  protected createEditorPanel(column = vscode.ViewColumn.One): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      CHAT_PANEL_TYPE,
      "Pi Agent Chat",
      // 默认 `One`、绝不用 `Active`：浮动窗口聚焦时 `Active` 会把新聊天开进
      // 那个窗口，与「在编辑区打开」相反。要去浮动窗口的载体才刻意传
      // `Active`——见 detachToNewWindow。
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
   * tab 图标。缺了它 tab 退回通用编辑器字形，移到编辑区或浮动窗口的聊天与
   * 文本文件一眼无异——那正是它与其他 tab 争辨识度的地方。恢复的 panel 也
   * 要设：`deserializeWebviewPanel` 交还的 panel 没走过 `createEditorPanel`。
   * 用两个文件而非活动栏那一个：tab 以 `<img>` 渲染，显示 SVG 自身颜色，
   * `currentColor` 按图片文档解析、任何主题都是黑色；`{ light, dark }` 是
   * 平台对此的答案。
   */
  private applyPanelIcon(panel: vscode.WebviewPanel): void {
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, "media", "icon-light.svg"),
      dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "icon-dark.svg"),
    };
  }

  protected bindEditorPanel(panel: vscode.WebviewPanel, controller: ChatController): void {
    const surface = this.connectEditorPanel(panel, false);
    surface.bind(controller);
    this.updatePanelTitle(surface);
  }

  // 在 runtime 就绪之前先建立 panel/webview 生命周期。
  protected connectEditorPanel(panel: vscode.WebviewPanel, renderImmediately: boolean): SurfaceConnection {
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
      // 主窗口第一个编辑器组是浮动窗口永远拿不到的列号，它是用户手动拖拽
      // tab 时对区域记账唯一可靠的校正。
      if (panel.viewColumn === vscode.ViewColumn.One) entry.region = "editor";
      if (panel.active) this.activePanel = entry;
      this.updateMoveMenuContext();
    });
    if (renderImmediately) surface.render();
    this.updateMoveMenuContext();
    return surface;
  }

  protected markRegion(panel: vscode.WebviewPanel, region: PanelRegion): void {
    const entry = [...this.panels.values()].find((candidate) => candidate.panel === panel);
    if (!entry) return;
    entry.region = region;
    this.updateMoveMenuContext();
  }

  /**
   * 标题栏命令作用的 tab。
   *
   * `WebviewPanel.active` 至多一个为真——工作台的活动编辑器，与 VS Code 评估
   * `activeWebviewPanelId` 用的是同一事实，实时读取让命令与提供它的菜单落在
   * 同一 tab 上。追踪值只补「焦点完全离开编辑区」的空档（点菜单就会这样）。
   */
  protected activeEntry(): EditorPanelEntry | undefined {
    const entries = [...this.panels.values()];
    const live = entries.find((entry) => entry.panel.active);
    if (live) return live;
    if (this.activePanel && this.panels.has(this.activePanel.surface)) return this.activePanel;
    return entries.length === 1 ? entries[0] : undefined;
  }

  protected activeSurface(): SurfaceConnection | undefined {
    return this.activeEntry()?.surface ?? this.sidebar;
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

  /** 会话文件在本窗口的任务线角色，无论哪个 controller 在跑。 */
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
   * 让「移动会话」菜单项与两个 surface 实际持有的会话同步（manifest 里的
   * `when: !piAgentChat.<slot>SessionEmpty`）。空会话不提供移动——每个目标
   * 区域都有等价的「在…新开会话」项。从 notifySessionsChanged() 调用：凡
   * 改变「哪个 controller 坐在哪个 surface」的路径（state post、交换、移动、
   * 释放）都汇聚到这里；上下文值一落 VS Code 就重估菜单 `when` 子句。
   */
  protected updateMoveMenuContext(): void {
    const sidebarEmpty = !isMovableSessionState(this.sidebarController?.state);
    const active = this.activeEntry();
    const tabEmpty = !isMovableSessionState(active?.surface.controller?.state);
    const tabRegion = active?.region ?? "editor";
    // 每次 state post 都会跑；只有真正的翻转才该到达 VS Code。
    if (this.moveMenuContext?.sidebarEmpty === sidebarEmpty
      && this.moveMenuContext.tabEmpty === tabEmpty
      && this.moveMenuContext.tabRegion === tabRegion) return;
    this.moveMenuContext = { sidebarEmpty, tabEmpty, tabRegion };
    void vscode.commands.executeCommand("setContext", "piAgentChat.sidebarSessionEmpty", sidebarEmpty);
    void vscode.commands.executeCommand("setContext", "piAgentChat.chatTabSessionEmpty", tabEmpty);
    void vscode.commands.executeCommand("setContext", "piAgentChat.chatTabRegion", tabRegion);
  }

  protected updatePanelTitle(surface: SurfaceConnection | undefined): void {
    const entry = surface ? this.panels.get(surface) : undefined;
    if (!entry) return;
    entry.panel.title = editorPanelTitle(surface?.controller?.state?.sessionName);
  }

  protected reportError(surface: SurfaceConnection | undefined, error: unknown): void {
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

  /**
   * 由 `ChatSurfaceManager`（`manager.ts`）实现的 controller 级另一半：构建
   * controller（串行化）、surface 消息路由、启动记忆、无面销毁与 claim 释放。
   */
  protected abstract createController(slot: SurfaceKind, requestedStartup: StartupSession): Promise<ChatController>;
  protected abstract handleSurfaceMessage(surface: SurfaceConnection, message: WebviewMessage): Promise<void>;
  protected abstract startupSession(slot: SurfaceKind): StartupSession;
  protected abstract disposeIfSettledHeadless(controller: ChatController | undefined): void;
  protected abstract releaseController(controller: ChatController): void;
}
