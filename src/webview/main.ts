import type { ChatState, HostMessage } from "../shared/protocol.js";
import {
  CONTENT_WIDTH_MIN,
  DEFAULT_CONTENT_MAX_WIDTH,
  DEFAULT_WIDE_THRESHOLD,
  WIDE_THRESHOLD_MIN,
} from "../shared/protocol.js";
import { clearFileRefs, initComposer, onAttachment, onProjectFiles, populateInputHistoryFromEvents, send, setInput, setSlashCommands } from "./composer.js";
import { getPersisted, post, setPersisted } from "./host.js";
import { setFoldMaxLines } from "./bubble.js";
import { getDict } from "./i18n.js";
import { SEND_ICON, STOP_ICON } from "./icons.js";
import { hasResources, isResourcesShown, renderResources, setResourcesLayout, setResourcesShown, toggleResources } from "./resources-view.js";
import { renderExtensionWidgets } from "./widgets.js";
import { initSessions, isSessionsVisible, renderSessions, setSessionsVisible } from "./sessions-view.js";
import { closePicker, openPicker, refreshPicker, setModelCatalog, togglePicker } from "./picker.js";
import { closeSearch, toggleSearch } from "./search.js";
import { initSplitters, reflowRails, setAvailableWidth, setRailOpen } from "./splitter.js";
import { initScrollbars } from "./scrollbars.js";
import { createOverflowGroup } from "./overflow.js";
import {
  authEl,
  byId,
  chatColumnEl,
  composerActionsEl,
  composerEl,
  composerMenuEl,
  composerMoreBtn,
  delegationBarEl,
  delegationLabelEl,
  delegationPeerBtn,
  followUpBtn,
  headerActionsEl,
  headerContentEl,
  headerMenuEl,
  headerMoreBtn,
  headerTitleEl,
  inputEl,
  messagesWrapEl,
  modelBtn,
  newBtn,
  recallBtn,
  resourcesBtn,
  rootEl,
  searchBtn,
  resourcesEl,
  sendBtn,
  sessionsBtn,
  settingsBtn,
  steerBtn,
  thinkingBtn,
  treeBtn,
} from "./shell.js";
import { renderExtensionStatus, renderStatusLine, updateStatusLineFit } from "./statusline.js";
import { currentLane, isDelegating, isInLane, setState, state } from "./store.js";
import { applyEvent, applyHistory, assignEntryIds, clearMessages, hasPendingBubbles, removePendingBubbles, setEntryActionsLocked, setShowThinking, showNewSession, updateWorkingIndicator } from "./transcript.js";

/**
 * 应用外壳：把各视图模块接线到一起，负责页面布局（聊天 / 会话 / 认证门）
 * 并路由宿主消息。
 *
 * 其余一切都归各自的模块；本文件应保持在一屏多一点就能读完的体量。
 */

const t = getDict();

/**
 * 居中聊天列的最大宽度（`piAgentChat.layout.contentMaxWidth`）。首次布局
 * 前从 webview 持久化状态恢复：控制器交换会重赋 `webview.html`，新
 * webview 若等 `ready` 往返才拿到配置值，会先用文档默认值做一次宽窄
 * 判定——宽窄不得依赖消息时序。首次加载走默认值。
 */
function initialContentMaxWidth(): number {
  const saved = getPersisted<number>("contentMaxWidth");
  if (saved === undefined || !Number.isFinite(saved)) return DEFAULT_CONTENT_MAX_WIDTH;
  return Math.max(CONTENT_WIDTH_MIN, Math.round(saved));
}

/** 与列宽同一条规则：首次布局前先恢复。 */
function initialWideThreshold(): number {
  const saved = getPersisted<number>("wideMinWidth");
  if (saved === undefined || !Number.isFinite(saved)) return Math.max(WIDE_THRESHOLD_MIN, DEFAULT_WIDE_THRESHOLD);
  return Math.max(WIDE_THRESHOLD_MIN, Math.round(saved));
}

let contentMaxWidth = initialContentMaxWidth();
let wideMinWidth = initialWideThreshold();
// webview 重载后行内样式不保，恢复值必须在首帧绘制前写回自定义属性——
// 否则布局一边按配置宽度做宽窄判定、一边按样式表默认值排列宽，直到
// `ready` 往返赶上为止。
document.documentElement.style.setProperty("--content-max-width", `${contentMaxWidth}px`);

/**
 * 记住本 webview 正在显示哪个会话，窗口重载后 tab 据此恢复。
 *
 * 宿主代存不了：VS Code 对每个保留的 panel 各调一次反序列化、只交还它
 * 自己的 webview state，N 个聊天 tab 就需要 N 份记忆。只有 live 主会话
 * 才计入——lane / replay 显示的是别人的 transcript，不是本 tab 的会话。
 */
function rememberSessionForRestore(next: ChatState): void {
  if (next.inputDisabled) return;
  setPersisted("session", next.sessionFile ? { cwd: next.cwd, file: next.sessionFile } : undefined);
}

/**
 * webview 达到配置阈值（`piAgentChat.layout.wideModeMinWidth`，宿主已夹到
 * 三栏确实摆得下的宽度）后宽屏可用。跨过阈值**什么都不打开**：只改变
 * header 会话/资源开关的含义（窄屏整页/浮层 ↔ 宽屏停靠栏）并让分隔线
 * 可拖，阈值因此不是界面在用户背后自行重排的点，而是侧栏「成为可能」
 * 的点。
 *
 * 旧版由列宽推导阈值，把「正文能多宽」与「侧栏何时出现」绑成一件事：
 * 正文调宽会把侧栏无端推远，故拆开。
 */
function applyLayoutGeometry(maxWidth: number, minWide: number): void {
  const width = Number.isFinite(maxWidth) ? Math.max(CONTENT_WIDTH_MIN, Math.round(maxWidth)) : DEFAULT_CONTENT_MAX_WIDTH;
  const threshold = Number.isFinite(minWide)
    ? Math.max(WIDE_THRESHOLD_MIN, Math.round(minWide))
    : Math.max(WIDE_THRESHOLD_MIN, DEFAULT_WIDE_THRESHOLD);
  if (width === contentMaxWidth && threshold === wideMinWidth) return;
  contentMaxWidth = width;
  wideMinWidth = threshold;
  document.documentElement.style.setProperty("--content-max-width", `${width}px`);
  setPersisted("contentMaxWidth", width);
  setPersisted("wideMinWidth", threshold);
  lastWidth = -1;
  applyViewportWidth(document.documentElement.clientWidth);
}

let wideLayout = false;
let sessionsPageOpen = false;
/**
 * 宽屏两条侧栏各自是否停靠打开。
 *
 * 起始均为关闭，并从本 webview 自己的持久化状态恢复。进入宽屏不得打开
 * 用户没要过的栏；但重开窗口、或窄宽往返，不能丢掉用户做过的选择——
 * 两件事不同，只有前者才算「自动打开」。
 */
const wideRailsOpen = {
  sessions: getPersisted<boolean>("wideSessionsOpen") === true,
  resources: getPersisted<boolean>("wideResourcesOpen") === true,
};

/* ---------------------------------------------------------------- */
/* 页面布局 */
/* ---------------------------------------------------------------- */

/** 恰好在窄屏整页或宽屏侧栏可见期间让宿主保持订阅。 */
function setSessionListVisible(visible: boolean): void {
  const changed = visible !== isSessionsVisible();
  setSessionsVisible(visible);
  if (changed) post({ type: "sessionsVisible", visible });
}

/** 窄表面上会话页替换聊天区。 */
function openSessions(): void {
  if (wideLayout) return;
  closePicker();
  closeSearch();
  sessionsPageOpen = true;
  setSessionListVisible(true);
  chatColumnEl.classList.add("hidden");
  authEl.classList.add("hidden");
  applyResourcesVisibility();
  updateHeaderButtons();
}

function closeSessions(): void {
  sessionsPageOpen = false;
  if (!wideLayout) setSessionListVisible(false);
  chatColumnEl.classList.remove("hidden");
  updateHeaderButtons();
  if (state.needsAuth) {
    applyAuthGate();
    return;
  }
  showChat();
}

/**
 * header 按钮始终可见；原先隐藏它们的状态改为禁用（配 not-allowed 光标）。
 */
function updateHeaderButtons(): void {
  const emptySession = (state.messageCount ?? 0) === 0;
  const busy = state.isStreaming || state.isCompacting || isDelegating() || Boolean(state.inputDisabled);
  const gated = state.ready && Boolean(state.needsAuth);
  // 空聊天页上「新会话」没有意义，但在会话页上它兼任「回到全新会话」，
  // 因此那里保持可点。运行中的会话不禁用它：宿主会让原 controller 转
  // 后台跑完，再把新的会话交给同一表面。
  newBtn.disabled = (emptySession && !sessionsPageOpen) || Boolean(state.inputDisabled);
  treeBtn.disabled = emptySession || busy || gated;
  // 会话在两种布局下都是开关：窄屏整页与宽屏左栏。
  sessionsBtn.disabled = gated;
  const sessionsShown = wideLayout ? wideRailsOpen.sessions : sessionsPageOpen;
  sessionsBtn.setAttribute("aria-pressed", String(sessionsShown));
  sessionsBtn.classList.toggle("active", sessionsShown);
  // 每种布局模式有自己的资源开关状态；见 `setResourcesLayout`。
  resourcesBtn.disabled = !hasResources() || sessionsPageOpen;
  // 搜索只对已有 transcript 的当前会话有意义；在窄屏会话页上触发时先
  // 回到那个 transcript。
  searchBtn.disabled = emptySession || gated;
}

/**
 * 资源面板只在 header 开关要求展示、且有清单可显示时出现，绝不盖在
 * 会话页或认证页上。
 *
 * 宽屏下面板是停靠栏，可见性必须传到 grid：关闭的栏要收起自己的轨道
 * 与分隔线，聊天列才能接管那块空间。
 */
function applyResourcesVisibility(): void {
  const shown = isResourcesShown();
  const gated = state.ready && Boolean(state.needsAuth);
  const visible = shown && hasResources() && !gated && !sessionsPageOpen;
  resourcesEl.classList.toggle("hidden", !visible);
  if (wideLayout) setRailOpen("resources", visible);
  resourcesBtn.setAttribute("aria-pressed", String(shown));
  resourcesBtn.classList.toggle("active", shown);
}

function showChat(): void {
  chatColumnEl.classList.remove("hidden");
  messagesWrapEl.classList.remove("hidden");
  composerEl.classList.remove("hidden");
  applyResourcesVisibility();
  delegationBarEl.classList.toggle("hidden", !isInLane());
  // composer 隐藏期间测不到尺寸；现在补一次布局判定。
  updateResponsiveLayout();
}

/**
 * 未认证任何供应商时，聊天区换成设置页：没有模型就无法开始会话。
 */
function applyAuthGate(): void {
  const gated = state.ready && Boolean(state.needsAuth);
  // 沿用旧的窄屏契约：认证设置优先于打开的会话页；宽屏侧栏独立、保持可见。
  if (gated && sessionsPageOpen && !wideLayout) {
    sessionsPageOpen = false;
    setSessionListVisible(false);
  }
  authEl.classList.toggle("hidden", !gated || sessionsPageOpen);
  if (sessionsPageOpen) {
    chatColumnEl.classList.add("hidden");
    applyResourcesVisibility();
    return;
  }
  chatColumnEl.classList.remove("hidden");
  if (gated) {
    messagesWrapEl.classList.add("hidden");
    composerEl.classList.add("hidden");
    delegationBarEl.classList.add("hidden");
    applyResourcesVisibility();
  } else {
    showChat();
  }
}

/**
 * 子代理 transcript 上方的横幅，含历史 lane 回放。运行期间不显示在父
 * 会话上：transcript 里的 lane 卡片已说完一切，这里再重复只会把对话顶下去。
 */
function renderDelegationBar(): void {
  const delegation = state.delegation;
  if (!delegation || !isInLane()) {
    delegationBarEl.classList.add("hidden");
    return;
  }
  delegationBarEl.classList.remove("hidden");
  const lane = currentLane();
  delegationLabelEl.textContent = t.subagentRunning(lane?.title ?? "");
  // 绝不自动切回父会话（那会把用户从选定的内容里拽走），改说它已有新进展。
  delegationPeerBtn.textContent = delegation.parentHasNewActivity ? t.backToParentNew : t.backToParent;
}

/**
 * header 标题显示用户所在位置：历史子代理的标题、当前会话的显示名（或
 * 首条消息）、或「新会话」占位。插件名本身已在 VS Code 视图标题里。
 */
function renderHeaderTitle(): void {
  const text = state.preview?.title || state.sessionName || t.newSessionLabel;
  const renamable = state.ready && !state.preview && !state.inputDisabled;
  headerTitleEl.textContent = text;
  headerTitleEl.classList.toggle("renamable", renamable);
  headerTitleEl.title = renamable ? `${text}\n${t.headerRenameTitle}` : text;
}

/* ---------------------------------------------------------------- */
/* 状态 */
/* ---------------------------------------------------------------- */

function applyState(next: ChatState): void {
  setState(next);
  rememberSessionForRestore(next);
  renderHeaderTitle();
  const childReadOnly = Boolean(state.inputDisabled);
  const parentWaiting = state.delegation?.role === "parent" && isDelegating();
  const active = state.isStreaming || state.isCompacting;
  sendBtn.innerHTML = active ? STOP_ICON : SEND_ICON;
  sendBtn.title = active
    ? state.isCompacting
      ? t.stopCompactionTitle
      : childReadOnly
        ? t.stopSubagentTitle
        : parentWaiting
          ? t.stopTaskLineTitle
          : t.stopIconTitle
    : t.sendIconTitle;
  sendBtn.classList.toggle("stop", active);
  inputEl.disabled = Boolean(state.inputDisabled);
  inputEl.placeholder = childReadOnly
    ? t.subagentInputDisabled
    : state.isCompacting
      ? t.compactionInputPlaceholder
      : t.inputPlaceholder;
  // 运行中的 live lane 保留停止控件；历史回放没有可停的东西，整体禁用。
  sendBtn.disabled = !state.ready || (childReadOnly && !active);
  steerBtn.classList.toggle("hidden", !state.isStreaming || state.isCompacting || childReadOnly);
  followUpBtn.classList.toggle("hidden", !active || childReadOnly);
  updateRecallButton();
  steerBtn.title = parentWaiting ? t.parentSteerTitle : t.steerTitle;
  followUpBtn.title = state.isCompacting
    ? t.queueAfterCompactionTitle
    : parentWaiting
      ? t.parentFollowUpTitle
      : t.followUpTitle;
  // 模型 / 思考等级的值自解释，不需要文字前缀。
  modelBtn.textContent = state.modelId ?? "-";
  modelBtn.title = state.providerId ? `${t.modelTitle}: ${state.providerId}/${state.modelId}` : t.modelTitle;
  thinkingBtn.textContent = state.thinkingLevel ?? "-";
  // 不可选思考等级的模型只报一个固定值（通常是 off）；隐藏控件免得点开一个死胡同。
  const canSelectThinkingLevel = (state.thinkingLevels?.length ?? 0) > 1;
  thinkingBtn.classList.toggle("hidden", !canSelectThinkingLevel);
  modelBtn.disabled = childReadOnly;
  thinkingBtn.disabled = !canSelectThinkingLevel || childReadOnly;
  // 禁用的 chip 不能留着打开的弹层；开着的弹层要反映新的当前模型 / 等级。
  if (modelBtn.disabled && thinkingBtn.disabled) closePicker();
  else refreshPicker();
  // 全新空会话不能再新建或导航，任务线运行中禁止切换：均显示为禁用。
  updateHeaderButtons();
  // 每条消息的会话树动作只对已落定的 live transcript 有意义：子代理运行
  // 中不行，显示着子代理 transcript 时也不行（那些 entry 不是父会话可
  // 回溯或加标签的）。
  setEntryActionsLocked(active || isDelegating() || isInLane());
  renderDelegationBar();
  applyAuthGate();
  renderStatusLine();
  updateWorkingIndicator();
  // 按钮文案与可见性刚变过，行的排布可能随之变化，重判一次。
  updateResponsiveLayout();
}

/* ---------------------------------------------------------------- */
/* 响应式布局 */
/* ---------------------------------------------------------------- */

/**
 * 面板过窄时，次要动作收进「...」弹层而不是换行，状态行则整体消失。
 * 会话标题保住最小宽度（CSS），绝不最先消失。
 */
const headerOverflow = createOverflowGroup({
  row: headerActionsEl,
  items: [newBtn, sessionsBtn, treeBtn, searchBtn, resourcesBtn, settingsBtn],
  toggle: headerMoreBtn,
  menu: headerMenuEl,
  // 编辑区 tab 自带标题，隐藏的 header 标题不占预算；辅助侧栏保留标题
  // 及其最小可读宽度。
  available: () => {
    const style = getComputedStyle(headerContentEl);
    const inner = headerContentEl.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const titleStyle = getComputedStyle(headerTitleEl);
    if (titleStyle.display === "none") return inner;
    const titleFloor = parseFloat(titleStyle.minWidth) || 0;
    return inner - titleFloor - (parseFloat(style.columnGap) || 0);
  },
});
const composerOverflow = createOverflowGroup({
  row: composerActionsEl,
  items: [modelBtn, thinkingBtn, steerBtn, followUpBtn, recallBtn],
  toggle: composerMoreBtn,
  menu: composerMenuEl,
  // 动作行横跨整个 composer，它自己的盒子就是预算。
  available: () => composerActionsEl.clientWidth,
});

function updateResponsiveLayout(): void {
  headerOverflow.update();
  composerOverflow.update();
  updateStatusLineFit();
}

function setWideLayout(wide: boolean): void {
  if (wideLayout === wide) return;
  wideLayout = wide;
  rootEl.classList.toggle("layout-wide", wide);
  // 停靠栏与窄屏浮层是两个表面、两份状态；先交给即将进入的模式，再让
  // 任何代码去读。
  setResourcesLayout(wide);

  if (wide) {
    // 窄屏整页清单不会自动变成停靠栏：跨过阈值不打开用户此前没在宽屏
    // 开过的东西。
    sessionsPageOpen = false;
    setSessionListVisible(wideRailsOpen.sessions);
    chatColumnEl.classList.remove("hidden");
    // 宽屏面板状态由外壳记忆，不是面板自己的默认值。
    setResourcesShown(wideRailsOpen.resources);
  } else {
    // 宽屏绝不把隐藏的整页状态带回窄屏浮层。
    setSessionListVisible(sessionsPageOpen);
  }
  applySessionsRail();

  applyAuthGate();
  applyResourcesVisibility();
  updateHeaderButtons();
}

/** 把会话栏的开合状态镜像进宽屏 grid。 */
function applySessionsRail(): void {
  if (wideLayout) setRailOpen("sessions", wideRailsOpen.sessions);
}

// 这里只有宽度有意义；高度每次变化（输入框可被用户拖高）都重算纯属
// 浪费。ResizeObserver 是事件驱动的，不轮询表面。
let lastWidth = -1;
function applyViewportWidth(width: number): void {
  const rounded = Math.round(width);
  if (rounded === lastWidth) return;
  lastWidth = rounded;
  // 分隔线按喂进来的观测宽度工作而不是自行测量表面，宽度必须先落地，
  // 再让它们重新夹取。
  setAvailableWidth(rounded);
  setWideLayout(rounded >= wideMinWidth);
  // 窗口收窄时逐步收回落栏，而不是把聊天列挤过最小宽度；再也满足不了
  // 自身最小值的栏直接关闭，与拖到那里的结果一致。
  if (wideLayout) reflowRails();
  updateResponsiveLayout();
}

new ResizeObserver((entries) => {
  applyViewportWidth(entries[0]?.contentRect.width ?? 0);
}).observe(document.documentElement);

/* ---------------------------------------------------------------- */
/* 接线 */
/* ---------------------------------------------------------------- */

initComposer({ beforeSend: closeSessions });
initSessions({ close: closeSessions, onResume: clearFileRefs });

/** 运行或压缩期间，发送按钮变为停止按钮。 */
sendBtn.addEventListener("click", () => {
  if (state.isStreaming || state.isCompacting) post({ type: "abort" });
  else if (!state.inputDisabled) send();
});
steerBtn.addEventListener("click", () => send("steer"));
followUpBtn.addEventListener("click", () => send("followUp"));
recallBtn.addEventListener("click", () => post({ type: "dequeue" }));

/** 仅在还有排队 / 插话消息等待时可见。 */
function updateRecallButton(): void {
  recallBtn.classList.toggle("hidden", !hasPendingBubbles() || Boolean(state.inputDisabled) || Boolean(state.preview));
}

/** CLI 的 dequeue：撤回的文本放在正在输入的内容之前。 */
function prependToInput(texts: string[]): void {
  const combined = [...texts, inputEl.value].filter((part) => part.trim()).join("\n\n");
  setInput(combined);
}
modelBtn.addEventListener("click", () => togglePicker("model"));
thinkingBtn.addEventListener("click", () => togglePicker("thinking"));
headerTitleEl.addEventListener("dblclick", () => {
  if (headerTitleEl.classList.contains("renamable")) post({ type: "renameCurrentSession" });
});
newBtn.addEventListener("click", () => {
  closeSessions();
  // 当前 runtime 被占用时，宿主只替换本表面的 GUI controller；新会话
  // 就绪前不要清掉正在跑的 transcript。
  const preserveCurrent = state.isStreaming || state.isCompacting || isDelegating() || Boolean(state.inputDisabled);
  if (!preserveCurrent) {
    clearFileRefs();
    // 新会话没有历史可等：这里显示加载态只会在一次往返里闪一下。
    showNewSession();
  }
  post({ type: "newSession" });
});
treeBtn.addEventListener("click", () => {
  if (sessionsPageOpen) closeSessions();
  post({ type: "openSessionTree" });
});
resourcesBtn.addEventListener("click", () => {
  toggleResources();
  if (wideLayout) {
    wideRailsOpen.resources = isResourcesShown();
    setPersisted("wideResourcesOpen", wideRailsOpen.resources);
  }
  applyResourcesVisibility();
  updateHeaderButtons();
});
searchBtn.addEventListener("click", () => {
  if (sessionsPageOpen) closeSessions();
  toggleSearch();
});
byId("btn-login").addEventListener("click", () => post({ type: "login" }));
byId("btn-logout").addEventListener("click", () => post({ type: "logout" }));
byId("btn-settings").addEventListener("click", () => post({ type: "openSettings" }));
byId("btn-sessions").addEventListener("click", () => {
  if (wideLayout) {
    setWideSessionsOpen(!wideRailsOpen.sessions);
  } else if (sessionsPageOpen) {
    closeSessions();
  } else {
    openSessions();
  }
});

/** 会话栏状态的唯一写入口：header 开关与拖拽关闭共用。 */
function setWideSessionsOpen(open: boolean): void {
  wideRailsOpen.sessions = open;
  setPersisted("wideSessionsOpen", open);
  setSessionListVisible(open);
  applySessionsRail();
  updateHeaderButtons();
}

// 覆盖式滚动条只在容器真正滚动时绘制，而 CSS 没有「正在滚动」状态可用。
// 一个捕获阶段监听器覆盖视图内所有滚动容器，包括后来渲染的。
initScrollbars();

// 把分隔线拖过某栏的最小宽度会关闭该栏，header 开关与持久化选择必须
// 跟上：两种手势做的是同一个决定。
initSplitters((rail) => {
  if (rail === "sessions") {
    wideRailsOpen.sessions = false;
    setPersisted("wideSessionsOpen", false);
    setSessionListVisible(false);
    updateHeaderButtons();
    return;
  }
  if (isResourcesShown()) toggleResources();
  wideRailsOpen.resources = false;
  setPersisted("wideResourcesOpen", false);
  applyResourcesVisibility();
  updateHeaderButtons();
});
delegationPeerBtn.addEventListener("click", () => {
  // 历史子代理重放期间仍按 lane 呈现，所有可见的同伴动作都经这一条路返回。
  if (isInLane()) post({ type: "showLane" });
});

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === "state") applyState(message.state);
  // 本端不重渲染：宿主在阈值变更后总会跟一次 history 重放，已存在的
  // 气泡借机重新判定。
  else if (message.type === "foldThreshold") setFoldMaxLines(message.maxLines);
  // 本端不重渲染：宿主在设置变更后总会跟一次 history 重放，已有卡片
  // 借机重新判定展开与否。同上一条阈值规则。
  else if (message.type === "showThinking") setShowThinking(message.enabled);
  // 纯 CSS 几何配置；在哪落地就在哪生效，没有需要重渲染的东西。
  else if (message.type === "contentWidth") applyLayoutGeometry(message.maxWidth, message.wideMinWidth);
  else if (message.type === "event") {
    applyEvent(message.event);
    updateRecallButton();
  } else if (message.type === "history") {
    applyHistory(message.events, message.live, message.systemPromptOverridden, message.subagent, message.transcriptId, message.terminal);
    // 只有宿主标记为「会话成为 live」的重放才喂 composer 的 ↑ 输入历史；
    // composer 按 transcript 去重。
    if (message.populateInputHistory) populateInputHistoryFromEvents(message.transcriptId, message.events);
  }
  else if (message.type === "entryIds") {
    assignEntryIds(message.ids, message.labels, message.assistantIds, message.assistantLabels);
  }
  else if (message.type === "sessions") renderSessions(message.items);
  else if (message.type === "models") setModelCatalog(message.catalog);
  else if (message.type === "openPicker") openPicker(message.picker);
  else if (message.type === "commands") setSlashCommands(message.items);
  else if (message.type === "projectFiles") onProjectFiles(message.requestId, message.items, message.error);
  else if (message.type === "attachment") onAttachment(message.id, message.image, message.note, message.error);
  else if (message.type === "resources") {
    renderResources(message.sections);
    applyResourcesVisibility();
    updateHeaderButtons();
  } else if (message.type === "setInput") setInput(message.text);
  else if (message.type === "extensionStatus") renderExtensionStatus(message.items);
  else if (message.type === "extensionWidgets") renderExtensionWidgets(message.items);
  else if (message.type === "dequeued") {
    removePendingBubbles();
    prependToInput(message.texts);
    updateRecallButton();
  }
  else if (message.type === "clear") clearMessages();
});

post({ type: "ready" });
applyViewportWidth(document.documentElement.clientWidth);
