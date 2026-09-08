import * as vscode from "vscode";
import { existsSync } from "node:fs";
import { describeWithStack } from "../agent/errors.js";
import type { StartupSession } from "../agent/runtime.js";
import type { WebviewMessage } from "../shared/protocol.js";
import { ownedSessionFiles } from "./claims.js";
import { ChatController } from "./controller.js";
import { ChatSurfaceManagerPanels } from "./manager-panels.js";
import {
  claimedSessionSourceStartup,
  replacementStartupForRunningController,
  restoredSessionFile,
  shouldDisposeHeadlessRuntime,
} from "./rules.js";
import type { SurfaceConnection } from "./surface-connection.js";
import { CHAT_VIEW_ID, type LastSession, type SurfaceKind } from "./types.js";

const LEGACY_LAST_SESSION_KEY = "piAgentChat.lastSession";
const SIDEBAR_LAST_SESSION_KEY = "piAgentChat.lastSession.sidebar";

/**
 * 持有一个 VS Code 窗口内全部顶层聊天 runtime。
 *
 * webview 是可替换的呈现层。controller（runtime + bridge）可在 surface 间
 * 移动，编辑区 tab 关闭后其 controller 可无面保活到当前运行 settle。会话文件
 * 由 controller 而非 webview claim，无面运行不会被第二个 runtime resume 并
 * 发追加。
 */
export class ChatSurfaceManager extends ChatSurfaceManagerPanels {
  /**
   * 把侧边栏会话移入新的编辑区 tab（区域 B）。
   *
   * 永远开新 tab：「移到编辑区」不能悄悄顶掉别的 tab 显示的内容；让出的
   * 侧边栏立即接一个新会话。
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

  /** 把活动聊天 tab 的会话移到侧边栏，然后关掉该 tab。 */
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
      // 会话已离开该 tab；留一个空 tab 顶位意味着一次「移动」要关两样东西。
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
   * 把活动聊天 tab 从浮动窗口移回编辑区（区域 C → B）。
   *
   * VS Code 没有 `moveEditorToMainWindow` 命令也没有 tab 移动 API；可用的只有
   * `WebviewPanel.reveal(ViewColumn.One)`——它解析到主窗口第一个编辑器组并把
   * panel 移过去而不重建（1.134 实测）。
   */
  async moveToEditorArea(): Promise<void> {
    const entry = this.activeEntry();
    if (!entry) return;
    entry.panel.reveal(vscode.ViewColumn.One, false);
    entry.region = "editor";
    this.updateMoveMenuContext();
  }

  // 把来源会话直接移入新窗口，不经中间编辑区 tab。
  async moveToNewWindow(source: SurfaceKind): Promise<void> {
    if (source === "editor") {
      const entry = this.activeEntry();
      if (!entry) return;
      await this.detachToNewWindow(entry.panel);
      return;
    }
    // 侧边栏：VS Code 只在窗口间移动编辑区 tab、绝不移动 view，所以结构上必须
    // 有载体 editor panel。它在本窗口的停留必须一闪而过：panel 创建与 detach
    // 一气呵成，慢的东西（给让出的侧边栏补 controller）等它走了再做。
    try {
      const panel = this.createEditorPanel(vscode.ViewColumn.Active);
      const moved = this.sidebarController;
      if (moved) {
        moved.setSlot("editor");
        this.bindEditorPanel(panel, moved);
      }
      // 先 detach 再建任何东西：建 controller 的那几秒里，载体 tab 不能一直
      // 停在本窗口的编辑区。
      await this.detachToNewWindow(panel);
      if (moved) {
        // 新 controller 接管前，侧边栏保留被移会话的最后一帧——与旧顺序同样
        // 的陈旧窗口，只是没有编辑区中转。
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
   * 把一个 panel 送进浮动窗口。
   *
   * `workbench.action.moveEditorToNewWindow` 只作用于工作台的*活动*编辑器且不
   * 接参数，发命令前 panel 必须已激活——否则被分离的是碰巧活动的编辑器（用户
   * 当前的聊天）。载体因此建在 `ViewColumn.Active`：落在用户所在之处（含浮动
   * 窗口）并天然激活，无需跨窗口抢焦点——从另一窗口抢焦点不可靠，panel 会
   * 静默留在原地。
   */
  private async detachToNewWindow(panel: vscode.WebviewPanel): Promise<void> {
    panel.reveal(panel.viewColumn, false);
    if (!(await waitForPanelActive(panel))) {
      // 宁可放弃也不分离别人的编辑器：会话两种情况下都活着，只是留在创建它
      // 的地方当 tab。
      this.log("new window: the carrier panel never became active; leaving it in the editor area");
      return;
    }
    await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
    this.markRegion(panel, "window");
  }

  // 复原 VS Code 在窗口重载期间保留的编辑区 panel。
  async restoreEditorPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    // serializer 回调重建 SDK runtime 可能花几秒。先绘制 webview 外壳，别让
    // 分离的窗口盯着 VS Code 黑色的未初始化 panel；controller 就绪后下面的
    // 绑定会重载它并走正常的 `ready` 握手。
    const surface = this.connectEditorPanel(panel, true);
    try {
      const controller = await this.createController("editor", this.restoredStartup(state));
      surface.bind(controller);
      this.updatePanelTitle(surface);
    } catch (error) {
      this.reportError(surface, error);
    }
  }

  /** tab 重开自己的会话；文件缺失或已被 claim 则降级为新会话。 */
  private restoredStartup(state: unknown): StartupSession {
    const file = restoredSessionFile(state, this.cwd);
    if (!file || this.claims.owner(file) || !existsSync(file)) return { mode: "new" };
    this.log(`reopening editor tab session: ${file}`);
    return { mode: "file", path: file };
  }

  async newSidebarSession(): Promise<void> {
    try {
      if (!this.sidebarController || !this.sidebar) {
        // view 会异步 resolve 并带上自己记住的会话；同一瞬间要求新会话会与它赛跑。
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

  /** 在编辑区新开会话（新 tab；不动其他 tab）。 */
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

  /** 在浮动窗口新开会话。 */
  async newWindowSession(): Promise<void> {
    try {
      // 先建 runtime、此时还没有载体 panel：panel 一旦创建就必须一口气移走，
      // 不能作为 tab 在本窗口编辑区干等建 controller 的那几秒。
      const controller = await this.createController("editor", { mode: "new" });
      const panel = this.createEditorPanel(vscode.ViewColumn.Active);
      this.bindEditorPanel(panel, controller);
      await this.detachToNewWindow(panel);
    } catch (error) {
      this.reportError(this.activeSurface(), error);
    }
  }

  /** 从会话列表在新的编辑区 tab 打开已有会话文件。 */
  async openSessionInEditor(file: string): Promise<void> {
    try {
      const panel = this.createEditorPanel();
      await this.adoptSessionInPanel(panel, file);
      panel.reveal(vscode.ViewColumn.One, true);
    } catch (error) {
      this.reportError(this.activeSurface(), error);
    }
  }

  // 在新浮动窗口打开已有会话文件。
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
   * 用 `file` 填充新建的 tab：把现有 owner 搬进来，而不是为同一 JSONL 造第二
   * 个 writer。可见的来源 surface 留一个新会话而不是一帧陈旧画面。
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

  protected async handleSurfaceMessage(surface: SurfaceConnection, message: WebviewMessage): Promise<void> {
    try {
      const controller = surface.controller;
      let effectiveMessage = message;
      if (message.type === "revealSession" && controller) {
        if (await this.moveClaimedSession(controller, surface, message.file)) {
          await this.revealLaneAfterMove(surface, message.file);
          return;
        }
        // 列表渲染后 owner 可能已释放 claim；走普通 live resume，别把过期行
        // 变成 no-op。
        effectiveMessage = { type: "resumeSession", file: message.file };
      }
      const replacement = replacementStartupForRunningController(
        effectiveMessage,
        Boolean(controller?.busy),
        controller?.claimedFile,
      );
      if (replacement) {
        // 构造之前先让现有 owner 胜出。会话列表导航已在上面处理；其余切换
        // 路径揭示 owner，而不是为同一 JSONL 开第二个 writer。
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
   * 替换可见会话只发生在请求它的那个 surface。运行中的 controller 被 detach
   * 而非 abort：它保住 claim 与事件订阅直到 settle，新会话或显式选中的会话
   * 接管同一 webview。
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

  /**
   * 给 controller 已去别处的 surface 补一个新会话。
   *
   * 一条规则一个地方：谁交出 controller，谁就要回答「让出的 surface 现在显示
   * 什么」。侧边栏的 controller 在没有绑定 view 时也被追踪（它可能关着），
   * 簿记跟着 kind 走而不是 connection。
   */
  private async refillSurface(kind: SurfaceKind, surface: SurfaceConnection | undefined): Promise<void> {
    const replacement = await this.createController(kind, { mode: "new" });
    if (kind === "sidebar") this.sidebarController = replacement;
    surface?.bind(replacement);
  }

  protected createController(slot: SurfaceKind, requestedStartup: StartupSession): Promise<ChatController> {
    const creation = this.creationQueue.then(async () => {
      // 激活期间侧边栏 resolve 与 panel 恢复可能赛跑。记住的文件要等更早的
      // controller 创建发布 claim 之后再复查，否则两个工厂可能打开同一 JSONL。
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

  protected startupSession(slot: SurfaceKind): StartupSession {
    // 只有侧边栏有窗口级记忆槽：编辑区 tab 各自带在 webview state 里。
    // 记忆来源见 restoredSessionFile。
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
   * controller 自己的会话文件变了（切换、新建，或首次追加让内存会话有了
   * 文件）。同时重读 lane，所有权的两半总是同步落地。
   */
  private updateControllerClaim(controller: ChatController, next: string | undefined): void {
    controller.claimedFile = next;
    this.updateControllerClaims(controller);
  }

  onControllerState(controller: ChatController): void {
    // 刻意不带 post 出的 `ChatState`：所有权跟着本 controller 的 runtime
    // *写*什么，永远不看它的 webview 显示什么。曾按 `state.sessionFile`
    // claim，子代理 transcript 一上屏就把自己的文件交了出去：第二个
    // controller 得以 resume 那个活会话，任务线在所有列表里变成普通行。
    this.updateControllerClaims(controller);
    if (controller.surface) this.updatePanelTitle(controller.surface);
    this.notifySessionsChanged();
    this.disposeIfSettledHeadless(controller);
  }

  /**
   * 发布本 controller 的所有权：自己的会话文件加运行中子代理正在追加的文件，
   * 释放不再写入的一切。
   *
   * 运行中的 lane 与顶层会话一样往自己的 JSONL 追加，需要同样的独占——否则
   * 别的 surface 能 resume 子代理的文件、造出第二个 writer。
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
      // 只有 controller 自己的会话能推倒重来；lane 文件被别人持有是别人簿记
      // 的 bug，不该为此丢掉本会话。
      if (file === controller.claimedFile) controller.claimConflict = true;
    }
  }

  redirectClaimedSession(requester: ChatController, file: string): boolean {
    const owner = this.claims.owner(file);
    if (!owner || owner === requester || owner.disposed) return false;
    if (owner.surface) owner.surface.reveal();
    else if (requester.surface) this.moveHeadlessController(owner, requester.surface);
    return true;
  }

  /**
   * 会话列表导航是空间性的：被选的 controller 搬到点击发生的 surface。若点击
   * 来自对端 surface，来源立即接一个空的新 controller；目标原 controller 仅在
   * 忙碌时无面保活。
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
   * lane 行寻址的是运行它的 controller：文件属于子代理，不是谁都能打开的会话。
   * 该 controller 移到请求方 surface 后，落在用户点的那条 lane 上而不是父
   * transcript。
   */
  private async revealLaneAfterMove(surface: SurfaceConnection, file: string): Promise<void> {
    const moved = surface.controller;
    if (!moved || moved.delegationRoleAt(file) !== "child") return;
    await moved.handleMessage({ type: "showLane", sessionFile: file });
  }

  // 把 claim 的后台运行搬进请求方 surface，不造第二个 writer。
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

  protected disposeIfSettledHeadless(controller: ChatController | undefined): void {
    if (!controller || controller.disposed || !shouldDisposeHeadlessRuntime({
      disposeWhenSettled: controller.disposeWhenSettled,
      visible: Boolean(controller.surface),
      busy: controller.busy,
      retainedSidebar: controller === this.sidebarController,
    })) return;
    // state post 发生在 SDK 事件栈内；等栈展开后再 dispose，扩展 shutdown 才
    // 不会让正在 settle 的 runner 失效。
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

  protected releaseController(controller: ChatController): void {
    for (const file of controller.claimedFiles) this.claims.release(file, controller);
    controller.claimedFiles.clear();
    controller.claimedFile = undefined;
    this.controllers.delete(controller);
    controller.dispose();
    this.notifySessionsChanged();
  }
}

/**
 * panel 成为工作台活动编辑器时 resolve；超时则 `false`。
 *
 * 有界是因为激活可能永远不来（焦点在别的窗口），调用方必须能区分这和成功。
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
