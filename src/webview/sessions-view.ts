import type { SessionListItem } from "../shared/protocol.js";
import { formatLocalTimestamp } from "../shared/time.js";
import { button, el, icon } from "./dom.js";
import { RENAME_ICON, OPEN_IN_EDITOR_ICON, NEW_WINDOW_ICON, TRASH_ICON } from "./icons.js";
import { MAX_SESSION_TITLE_CHARS, truncate } from "./format.js";
import { post } from "./host.js";
import { getDict } from "./i18n.js";
import { sessionsEl } from "./shell.js";
import { spinner } from "./spinner.js";
import { state } from "./store.js";
import { showLoading } from "./transcript.js";

/**
 * 会话列表：窄表面上是一个整页，宽模式下是常驻左栏。
 *
 * 显示 / 隐藏是 main.ts 的布局决定；本模块只渲染列表并上报用户的选择。
 */

const t = getDict();

/** 每批渲染的行数；滚动接近底部时追加下一批。 */
const PAGE_SIZE = 20;
/** 距底部多少像素时追加下一批。 */
const SCROLL_THRESHOLD = 200;

interface SessionsHooks {
  /** 离开会话页（布局归 main.ts）。 */
  close(): void;
  /** 切换会话前调用，用于丢弃 composer 状态。 */
  onResume(): void;
}

let hooks: SessionsHooks = { close: () => {}, onResume: () => {} };

/** 宿主推来的最新列表；搜索在内存里过滤，不重新扫盘。 */
let allItems: SessionListItem[] = [];
let searchQuery = "";
/** 当前已渲染进 DOM 的过滤后行数。 */
let renderedCount = 0;
let listEl: HTMLElement | undefined;
let searchInputEl: HTMLInputElement | undefined;

export function initSessions(sessionsHooks: SessionsHooks): void {
  hooks = sessionsHooks;
}

export function isSessionsVisible(): boolean {
  return !sessionsEl.classList.contains("hidden");
}

/** 切换整页 / 侧栏；变为可见时用最新缓存清单渲染。 */
export function setSessionsVisible(visible: boolean): void {
  const changed = visible === sessionsEl.classList.contains("hidden");
  sessionsEl.classList.toggle("hidden", !visible);
  if (visible && changed) renderSessions(allItems);
}

export function renderSessions(items: SessionListItem[]): void {
  allItems = items;
  if (!isSessionsVisible()) return;
  // 实时跨表面刷新时重建列表，必须保住搜索编辑状态与独立滚动列表的
  // 阅读位置。
  const focusSearch = document.activeElement === searchInputEl;
  const caret = searchInputEl?.selectionStart ?? searchQuery.length;
  const scrollTop = listEl?.scrollTop ?? 0;
  const rowBudget = Math.max(PAGE_SIZE, renderedCount);
  sessionsEl.replaceChildren();
  const content = el("div", "sessions-content content-column");
  sessionsEl.appendChild(content);

  const header = el("div", "sessions-header");
  header.append(el("span", undefined, t.sessionsHeader));
  content.appendChild(header);

  searchInputEl = document.createElement("input");
  searchInputEl.type = "text";
  searchInputEl.className = "sessions-search";
  searchInputEl.placeholder = t.sessionsSearchPlaceholder;
  searchInputEl.value = searchQuery;
  searchInputEl.addEventListener("input", () => {
    searchQuery = searchInputEl?.value ?? "";
    if (listEl) listEl.scrollTop = 0;
    renderList();
  });
  content.appendChild(searchInputEl);

  listEl = el("div", "sessions-list");
  listEl.addEventListener("scroll", () => {
    if (listEl && listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - SCROLL_THRESHOLD) renderMore();
  });
  content.appendChild(listEl);
  renderList(rowBudget);
  listEl.scrollTop = scrollTop;
  if (focusSearch && searchInputEl) {
    searchInputEl.focus();
    searchInputEl.setSelectionRange(caret, caret);
  }
}

function filteredItems(): SessionListItem[] {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return allItems;
  return allItems.filter((item) => item.title.toLowerCase().includes(query));
}

/** （重新）填充列表容器，通常只放第一批过滤结果。 */
function renderList(upTo = PAGE_SIZE): void {
  if (!listEl) return;
  listEl.replaceChildren();
  renderedCount = 0;
  const items = filteredItems();
  if (items.length === 0) {
    listEl.appendChild(el("div", "sessions-empty", allItems.length === 0 ? t.sessionsEmpty : t.sessionsNoMatch));
    return;
  }
  appendRows(items, upTo);
}

/** 页面滚动接近底部时追加下一批。 */
function renderMore(): void {
  if (!listEl || !isSessionsVisible()) return;
  const items = filteredItems();
  if (renderedCount >= items.length) return;
  appendRows(items, renderedCount + PAGE_SIZE);
}

function appendRows(items: SessionListItem[], upTo: number): void {
  if (!listEl) return;
  const end = Math.min(upTo, items.length);
  for (let i = renderedCount; i < end; i++) listEl.appendChild(sessionRow(items[i]!));
  renderedCount = end;
}

function sessionRow(item: SessionListItem): HTMLElement {
  // `running` 驱动 2px 状态条，它只报告「在跑」——当前会话由选中底色
  // 表达。被后台 controller claim 的会话同样在跑，只是不在这显示。
  const running = item.running || item.claimedElsewhere === "background";
  const row = el(
    "div",
    `session-row${item.current ? " current" : ""}${running ? " running" : ""}${item.claimedElsewhere ? ` claimed-${item.claimedElsewhere}` : ""}${item.delegationRole ? ` delegation-${item.delegationRole}` : ""}`,
  );
  row.title = item.file;

  const main = button("session-main", undefined, () => onRowClick(item));
  main.title = claimTitle(item) ?? t.sessionResumeTitle;
  const titleRow = el("span", "session-title");
  titleRow.appendChild(el("span", "session-title-text", truncate(item.title, MAX_SESSION_TITLE_CHARS)));
  // 徽章放元信息行行首而非标题前：放标题前会按自身宽度把标题顶右，只有
  // 部分会话在跑时整列标题左缘参差，而标题正是眼睛往下扫的那一列；元信
  // 息行本来就是次要行，所有标题都能从同一 x 起笔。
  const metaRow = el("span", "session-meta");
  const badge = statusBadge(item);
  if (badge) metaRow.appendChild(badge);
  metaRow.appendChild(el("span", "session-time", formatLocalTimestamp(item.timestamp)));
  main.append(titleRow, metaRow);
  row.appendChild(main);

  // 动作按钮在每行占固定槽位；不可用的动作置灰而不是抽走。
  const actions = el("div", "session-actions");
  actions.appendChild(renameButton(item));
  actions.appendChild(openInEditorButton(item));
  actions.appendChild(openInNewWindowButton(item));
  actions.appendChild(deleteButton(item));
  row.appendChild(actions);
  return row;
}

function onRowClick(item: SessionListItem): void {
  if (item.claimedElsewhere) {
    // 会话属于它的 controller，不属于任何一个 GUI：把那个 controller 原样
    // 搬到这里，宿主会让可见的来源面换成空会话。lane 行寻址运行它的
    // controller，搬过来之后宿主再落到那条 lane。
    post({ type: "revealSession", file: item.file });
    hooks.close();
    return;
  }
  if (item.delegationRole === "parent") {
    post({ type: "showLane" });
    hooks.close();
    return;
  }
  if (item.delegationRole === "child") {
    // 运行还记得它时按 id 寻址 lane，让它以子代理身份打开，而不是一个
    // 无关的只读会话。
    const lane = state.delegation?.lanes.find((entry) => entry.sessionFile === item.file);
    post({ type: "showLane", laneId: lane?.id, sessionFile: item.file });
    hooks.close();
    return;
  }
  if (!item.current) {
    hooks.onResume();
    // 加载大会话文件需要宿主一点时间；不这样做，旧 transcript 会留在屏
    // 幕上像卡死。当前 controller 忙时，宿主让它转后台继续，并给本表面
    // 一个选中会话的 controller。
    showLoading();
    post({ type: "resumeSession", file: item.file });
  }
  hooks.close();
}

function statusBadge(item: SessionListItem): HTMLElement | undefined {
  const badge = el("span", "session-badge");
  if (item.claimedElsewhere === "visible") {
    // 刻意用中性色：它描述的是本窗口的 claim，不是会话状态，不能读成
    // 「运行中」（见 `_sessions.scss`）。
    badge.textContent = t.sessionOpenElsewhere;
  } else if (item.delegationRole === "child") {
    // 排在「后台运行中」之前：父代理已离开屏幕的任务线两者皆真，而这条
    // 说的是它在干什么。点击仍按 claim 路由，点名角色不损失任何东西。
    badge.classList.add("subagent");
    badge.append(spinner(), document.createTextNode(t.sessionSubagentRunning));
  } else if (item.delegationRole === "parent") {
    badge.classList.add("subagent");
    badge.textContent = t.sessionParentWaiting;
  } else if (item.claimedElsewhere === "background") {
    badge.classList.add("running");
    badge.append(spinner(), document.createTextNode(t.sessionRunningInBackground));
  } else if (item.running) {
    badge.classList.add("running");
    // 与底部「工作中」指示同款盲文 spinner。文本里不加空格：徽章是 flex
    // 行、间距由 `gap` 决定，字面空格会翻倍。
    badge.append(spinner(), document.createTextNode(t.sessionRunning));
  } else if (item.current && state.preview) {
    badge.textContent = t.sessionPreviewing;
  } else {
    return undefined;
  }
  return badge;
}

function deleteButton(item: SessionListItem): HTMLElement {
  const del = button("session-action session-delete", undefined, (event) => {
    event.stopPropagation();
    post({ type: "deleteSession", file: item.file });
  });
  del.appendChild(icon(TRASH_ICON));
  if (item.current || item.running || item.delegationRole || item.claimedElsewhere) {
    del.disabled = true;
    del.title = claimTitle(item) ?? t.sessionDeleteCurrentTitle;
  } else {
    del.title = t.sessionDeleteTitle;
  }
  return del;
}

function claimTitle(item: SessionListItem): string | undefined {
  if (item.claimedElsewhere === "visible") return t.sessionOpenElsewhereTitle;
  if (item.claimedElsewhere === "background") return t.sessionBackgroundTitle;
  return undefined;
}

function openInEditorButton(item: SessionListItem): HTMLElement {
  const btn = button("session-action session-open-editor", undefined, (event) => {
    event.stopPropagation();
    post({ type: "openSessionInEditor", file: item.file });
    hooks.close();
  });
  btn.appendChild(icon(OPEN_IN_EDITOR_ICON));
  btn.title = t.sessionOpenInEditorTitle;
  return btn;
}

function openInNewWindowButton(item: SessionListItem): HTMLElement {
  const btn = button("session-action session-open-window", undefined, (event) => {
    event.stopPropagation();
    post({ type: "openSessionInNewWindow", file: item.file });
    hooks.close();
  });
  btn.appendChild(icon(NEW_WINDOW_ICON));
  btn.title = t.sessionOpenInNewWindowTitle;
  return btn;
}

function renameButton(item: SessionListItem): HTMLElement {
  const rename = button("session-action session-rename", undefined, (event) => {
    event.stopPropagation();
    post({ type: "renameSession", file: item.file });
  });
  rename.appendChild(icon(RENAME_ICON));
  // 运行中的子代理还在往会话文件追加，重命名须等运行结束。被其他表面
  // claim 的会话仍可重命名——重命名只追加元数据，不干扰。
  if (item.delegationRole === "child") {
    rename.disabled = true;
    rename.title = t.sessionRenameRunningTitle;
  } else {
    rename.title = t.sessionRenameTitle;
  }
  return rename;
}
