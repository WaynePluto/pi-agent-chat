import * as vscode from "vscode";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatEvent, ChatState, ExtensionWidget, WebviewMessage } from "../../shared/protocol.js";
import { buildHistoryEntryEvents } from "../history.js";
import { describe } from "../errors.js";
import type { OriginalContentProvider } from "../diff-view.js";
import { ProjectFileIndex } from "../project-files.js";
import { ActivityTracker } from "../activity.js";
import { EMPTY_PROMPT_INDEX, buildPromptIndex, type PromptIndex } from "../invocations.js";
import { EMPTY_SKILL_INDEX, buildSkillIndex, type SkillIndex } from "../skills.js";
import type { PiRuntime } from "../runtime.js";
import type { LaneNotice, LaneState, SubagentObserver, SubagentRun } from "../subagent.js";
import {
  builtinActions,
  reloadResources,
} from "./actions.js";
import {
  clearExtensionUiState,
  extensionErrorSink,
  extensionNoticeSink,
  extensionStatusSink,
  extensionWidgetSink,
  postExtensionStatus,
  postExtensionWidgets,
} from "./extension-ui.js";
import { onSessionEvent } from "./events.js";
import {
  delegationState,
  onLaneChanged,
  onLaneEvent,
  onLaneNotice,
  onLaneStarted,
  onRunFinished,
  onRunStarted,
  replayLaneSession,
  setView,
  showLane,
} from "./lanes.js";
import {
  createModelsConfigWatcher,
  login as loginFlowBridge,
  logout as logoutFlowBridge,
  refreshModelCatalog as refreshModelCatalogBridge,
  reloadModelsConfig,
  reportModelsConfigError,
} from "./models-config.js";
import { guardStreaming, handleMessage as handleMessageBridge } from "./messaging.js";
import { retryFailedRequest as retryFailedRequestBridge } from "./retry.js";
import { refreshSessions } from "./sessions-list.js";
import { createSettingsWatcher, disposeSettingsTimers } from "./settings.js";
import type { BridgeHost, CompactionQueuedPrompt, View } from "./types.js";
import {
  postCommands as postCommandsBridge,
  postEntryIds as postEntryIdsBridge,
  postHistory as postHistoryBridge,
  postModels as postModelsBridge,
  postResourceListing as postResourceListingBridge,
  postResources as postResourcesBridge,
  postState as postStateBridge,
  rememberSession,
  sessionDisplayName as sessionDisplayNameBridge,
} from "./updates.js";

/**
 * 把 `AgentSession` 事件翻译成 webview 消息，并把 webview 命令作用到
 * runtime。每次会话替换都重新订阅并重绑扩展（SDK 要求）。实现按子系统
 * 拆在 `./bridge/` 各模块；本类持有共享状态与生命周期，其余模块经
 * `bridge` 直取其内部成员——这是有意为之。
 */
export class ChatBridge implements vscode.Disposable, SubagentObserver {
  unsubscribe?: () => void;
  disposed = false;
  /** 最近一次交给 host.rememberSession 的值；首次同步前缺省。 */
  remembered?: { file: string | undefined };
  /**
   * 视图与子代理运行。view 是「webview 显示什么」的唯一事实源（见 View）。
   * laneSessions 跨运行累积、仅随显示会话替换而清空：已完成的 lane 也留在
   * 其中，从（仍可见的）工具卡片重开它才落在子代理视图，而不是退化为通用
   * 只读回放——窗口重载后能幸存的就只剩回放。lanes 保存历次运行的快照
   * （新者靠后）；parentActivityWhileAway 记用户看 lane 期间父会话有新进展。
   */
  view: View = { kind: "live" };
  activeRun?: SubagentRun;
  readonly laneSessions = new Map<string, AgentSession>();
  lanes: LaneState[] = [];
  parentActivityWhileAway = false;
  /**
   * 簿记与缓存：sessionsVisible 标记会话页 / 宽栏在屏；两个 PostVersion
   * 保证只有最新一次异步扫描 / 状态快照能到达 webview；availabilityProbe
   * 取消被取代投递里的可用性探测。histories 让父 / 子 transcript 互看时
   * 都完整。retryOutcomes 是纯 UI 状态（绝不写入共享会话文件），仅当其
   * sourceLeaf 仍在活动分支上才随回放重发。activeManualRetries：手动重试
   * 拿到任何成功响应（哪怕只是工具请求）即视为成功，之后的失败属于新一轮
   * 打断、自领新提议。liveFailedResponses 记实时 message_end 的错误事实
   * （settle 与持久化是不同 SDK 阶段），由后续非错误响应清除。
   */
  sessionsVisible = false;
  sessionsRefreshTimer?: ReturnType<typeof setTimeout>;
  sessionsChangedSubscription?: vscode.Disposable;
  sessionsPostVersion = 0;
  statePostVersion = 0;
  availabilityProbe?: AbortController;
  readonly histories = new Map<string, ChatEvent[]>();
  readonly retryOutcomes = new Map<string, { sourceLeafId: string; event: Extract<ChatEvent, { kind: "status" }> }>();
  readonly activeManualRetries = new Map<string, {
    offerIndex: number;
    sourceLeafId: string;
    succeeded: boolean;
  }>();
  readonly liveFailedResponses = new Set<string>();
  /**
   * 其余状态：extensionStatuses / extensionWidgets 存放扩展的 setStatus /
   * setWidget 条目，attach 时清空、由重绑的扩展重发（对齐 CLI）；
   * compactionQueues 是 SDK 压缩期间的应用层队列；skillIndex / promptIndex
   * 用于标注技能工具调用与归属 / 命令；activity 记录本会话真正生效过的
   * 资源（资源面板用）；pendingImages 到达即处理（拒绝趁用户还在编辑时
   * 冒出），被下一次 prompt 消费、随会话替换丢弃——它们属于正被替换的
   * composer。
   */
  readonly extensionStatuses = new Map<string, Map<string, string>>();
  readonly extensionWidgets = new Map<string, Map<string, ExtensionWidget>>();
  readonly compactionQueues = new Map<string, CompactionQueuedPrompt[]>();
  readonly pendingToolArgs = new Map<string, unknown>();
  skillIndex: SkillIndex = EMPTY_SKILL_INDEX;
  promptIndex: PromptIndex = EMPTY_PROMPT_INDEX;
  readonly projectFiles: ProjectFileIndex;
  readonly activity = new ActivityTracker();
  extensionCommandDepth = 0;
  readonly pendingImages = new Map<string, { name: string; mimeType: string; data: string; hints: string[] }>();
  nextAttachmentId = 0;
  modelsConfigWatcher?: vscode.Disposable;
  settingsWatcher?: vscode.Disposable;
  subagentConfigTimer?: ReturnType<typeof setTimeout>;
  terminalConfigTimer?: ReturnType<typeof setTimeout>;
  foldConfigTimer?: ReturnType<typeof setTimeout>;
  showThinkingConfigTimer?: ReturnType<typeof setTimeout>;
  foldLines?: number;
  showThinking?: boolean;
  modelsConfigError?: string;

  constructor(
    readonly runtime: PiRuntime,
    readonly host: BridgeHost,
    readonly diffProvider: OriginalContentProvider,
  ) {
    this.projectFiles = new ProjectFileIndex((message) => host.log(message));
    this.sessionsChangedSubscription = host.onDidChangeSessions?.(() => refreshSessions(this));
    runtime.subagents.setObserver(this);
    /* 四个 sink 都必须在 attach() 里第一次 bindExtensions() 之前接线：它们
       被那里创建的 context 捕获。error sink 不接则 SDK 静默丢弃扩展
       handler 失败（CLI 各 mode 都上报）；status / widget 是实时 UI 状态
       而非 transcript 历史，不进 histories、随显示会话变化重发。 */
    runtime.setSessionLifecycleSink({
      reattach: () => this.attach(),
      reload: () => reloadResources(this),
    });
    runtime.setExtensionNoticeSink((session, notice) => extensionNoticeSink(this, session, notice));
    runtime.setExtensionErrorSink((session, error) => extensionErrorSink(this, session, error));
    runtime.setExtensionStatusSink((session, update) => extensionStatusSink(this, session, update));
    runtime.setExtensionWidgetSink((session, update) => extensionWidgetSink(this, session, update));
    this.modelsConfigWatcher = createModelsConfigWatcher(this);
    this.settingsWatcher = createSettingsWatcher(this);
  }

  /** 订阅当前会话并推送初始状态。 */
  async attach(): Promise<void> {
    const started = Date.now();
    this.unsubscribe?.();
    const session = this.runtime.session;
    // 新会话一律以 live 进入，lanes 随之清空（lane 属于孵化它的会话）；附件属于正被替换的 composer，旧 id 对新会话无意义。
    this.view = { kind: "live" };
    this.lanes = [];
    this.laneSessions.clear();
    this.parentActivityWhileAway = false;
    this.pendingImages.clear();
    this.histories.clear();
    this.extensionStatuses.clear();
    this.extensionWidgets.clear();
    this.compactionQueues.clear();
    this.liveFailedResponses.clear();
    this.activity.reset();
    this.skillIndex = buildSkillIndex(session);
    this.promptIndex = buildPromptIndex(session);
    const events = this.buildHistory(session);
    const retryOutcome = this.retryOutcomes.get(session.sessionId);
    if (retryOutcome && session.sessionManager.getBranch().some((entry) => entry.id === retryOutcome.sourceLeafId)) {
      events.push(retryOutcome.event);
    }
    this.activity.noteHistory(events);
    this.histories.set(session.sessionId, events);
    this.unsubscribe = session.subscribe((event) => this.onSessionEvent(session, event));
    rememberSession(this);
    const built = Date.now();
    // 先送 transcript：绑定扩展与收集资源慢、渲染历史却用不着它们；populate 标记会话刚成为 live，其用户消息进入 ↑ 历史（对齐 CLI 初次渲染）。
    this.postHistory(true);
    const posted = Date.now();
    await this.runtime.bindExtensions();
    this.activity.noteBind(session);
    const bound = Date.now();
    this.postCommands();
    this.postResources();
    await this.postState();
    this.host.log(
      `session attach: ${events.length} events, build ${built - started}ms, post ${posted - built}ms, ` +
        `bind ${bound - posted}ms, resources+state ${Date.now() - bound}ms`,
    );
    refreshSessions(this);
    await reportModelsConfigError(this, session);
  }

  /**
   * isDisplayed：session 是否正是 webview 显示的那个。displayedSession：
   * UI 反映其 live 状态的会话——replay 展示静态 transcript，但仍上报
   * runtime 会话的模型 / 统计 / 名称：那些描述用户身在何处，回放是
   * 绕行而非搬家。
   */
  isDisplayed(session: AgentSession): boolean {
    return this.view.kind !== "replay" && this.displayedSession === session;
  }

  get displayedSession(): AgentSession {
    return this.view.kind === "lane" ? this.view.session : this.runtime.session;
  }

  buildHistory(session: AgentSession): ChatEvent[] {
    return buildHistoryEntryEvents(session.sessionManager.getBranch(), this.runtime.cwd, this.skillIndex, this.promptIndex);
  }

  emit(session: AgentSession, event: ChatEvent): void {
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
   * 发出者未说明位置时决定提示渲染在哪。运行级提示（重试、压缩、后台
   * 扩展提示）折入所属执行过程的 work block；空闲时没有这样的过程，
   * webview 会为装它新开一个 work block——显示为「运行中」直到后续轮次
   * 碰巧合上，还把用户没有理由进执行过程去找的消息藏进去，故空闲提示放
   * 顶层（用户主动要的提示所在）。直接回应了用户动作的发出者仍显式标
   * "command"：运行中也要停在顶层。
   */
  private placeNotice(session: AgentSession, event: ChatEvent): ChatEvent {
    if (event.kind !== "status" && event.kind !== "error") return event;
    if (event.scope !== undefined) return event;
    if (session.isStreaming || session.isCompacting) return event;
    return { ...event, scope: "command" };
  }

  /** 记录失败并作为 transcript 里的错误提示呈现。 */
  reportError(session: AgentSession, context: string, error: unknown, scope?: "command"): void {
    const messageText = describe(error);
    this.host.log(`${context}: ${messageText}`);
    this.emit(session, { kind: "error", text: messageText, scope });
  }

  guardStreaming(): boolean {
    return guardStreaming(this);
  }

  emitCommandStatus(text: string): void {
    this.emit(this.runtime.session, { kind: "status", text, scope: "command" });
  }

  emitCommandError(text: string): void {
    this.emit(this.runtime.session, { kind: "error", text, scope: "command" });
  }

  /** 处理一条来自 webview 的消息。 */
  handleMessage(message: WebviewMessage): Promise<void> {
    return handleMessageBridge(this, message);
  }

  onSessionEvent(session: AgentSession, event: AgentSessionEvent): void {
    onSessionEvent(this, session, event);
  }

  setView(view: View): void {
    setView(this, view);
  }

  showLane(laneId?: string, fallbackFile?: string, laneTitle?: string): void {
    showLane(this, laneId, fallbackFile, laneTitle);
  }

  replayLaneSession(file: string, laneTitle: string): Promise<void> {
    return replayLaneSession(this, file, laneTitle);
  }

  clearExtensionUiState(session: AgentSession): void {
    clearExtensionUiState(this, session);
  }

  retryFailedRequest(): Promise<void> {
    return retryFailedRequestBridge(this);
  }

  login(): Promise<boolean> {
    return loginFlowBridge(this);
  }

  logout(): Promise<boolean> {
    return logoutFlowBridge(this);
  }

  refreshModelCatalog(): Promise<void> {
    return refreshModelCatalogBridge(this);
  }

  reloadModelsConfig(): Promise<void> {
    return reloadModelsConfig(this);
  }

  postResourceListing(): void {
    postResourceListingBridge(this);
  }

  postResources(): void {
    postResourcesBridge(this);
  }

  postCommands(): void {
    postCommandsBridge(this);
  }

  postModels(): Promise<void> {
    return postModelsBridge(this);
  }

  postHistory(populateInputHistory = false): void {
    postHistoryBridge(this, populateInputHistory);
  }

  postEntryIds(): void {
    postEntryIdsBridge(this);
  }

  postState(): Promise<void> {
    return postStateBridge(this);
  }

  sessionDisplayName(session: AgentSession): string | undefined {
    return sessionDisplayNameBridge(session);
  }

  postExtensionStatus(): void {
    postExtensionStatus(this);
  }

  postExtensionWidgets(): void {
    postExtensionWidgets(this);
  }

  delegationState(session: AgentSession): ChatState["delegation"] {
    return delegationState(this, session);
  }

  builtinActions() {
    return builtinActions(this);
  }

  onRunStarted(run: SubagentRun): void {
    onRunStarted(this, run);
  }

  onLaneStarted(run: SubagentRun, lane: LaneState, session: AgentSession): void {
    onLaneStarted(this, run, lane, session);
  }

  onLaneChanged(run: SubagentRun, lane: LaneState): void {
    onLaneChanged(this, run, lane);
  }

  onLaneEvent(run: SubagentRun, lane: LaneState, event: AgentSessionEvent): void {
    onLaneEvent(this, run, lane, event);
  }

  onLaneNotice(run: SubagentRun, lane: LaneState, notice: LaneNotice): void {
    onLaneNotice(this, run, lane, notice);
  }

  onRunFinished(run: SubagentRun): void {
    onRunFinished(this, run);
  }

  /**
   * 本 runtime 除自身会话外正在追加的会话文件：运行中各 lane。它既是
   * 所有权事实（子代理写入期间其他顶层会话不得打开它们），也是「子代理」
   * 徽章的来源——「lane 在跑」只有这一个定义。delegationRoleAt 则回答
   * 本 bridge 运行中某文件的任务线角色（父 / 子）。
   */
  runningLaneFiles(): string[] {
    if (!this.activeRun) return [];
    return this.lanes
      .filter((lane) => lane.status === "running")
      .map((lane) => lane.sessionFile)
      .filter((file): file is string => Boolean(file));
  }

  delegationRoleAt(file: string): "parent" | "child" | undefined {
    if (!this.activeRun) return undefined;
    if (this.runningLaneFiles().includes(file)) return "child";
    return file === this.runtime.session.sessionFile ? "parent" : undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.statePostVersion++;
    this.sessionsPostVersion++;
    this.modelsConfigWatcher?.dispose();
    this.modelsConfigWatcher = undefined;
    this.settingsWatcher?.dispose();
    this.settingsWatcher = undefined;
    disposeSettingsTimers(this);
    this.availabilityProbe?.abort();
    this.availabilityProbe = undefined;
    if (this.sessionsRefreshTimer) {
      clearTimeout(this.sessionsRefreshTimer);
      this.sessionsRefreshTimer = undefined;
    }
    this.sessionsChangedSubscription?.dispose();
    this.sessionsChangedSubscription = undefined;
    this.runtime.subagents.setObserver(undefined);
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
