import { SUBAGENT_TOOL, type ChatEvent, type JsonValue, type SkillRef } from "../../shared/protocol.js";
import { CARD_CLASSES, WORK_CLASSES, createCollapsible } from "../collapsible.js";
import { button, el } from "../dom.js";
import {
  MAX_DIFF_LINES,
  MAX_LANE_DETAIL_CHARS,
  MAX_TOOL_ARGS_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  truncate,
} from "../format.js";
import { post } from "../host.js";
import { getDict } from "../i18n.js";
import { renderMarkdown } from "../markdown.js";
import { markSkillActive, markToolUsed } from "../resources-view.js";
import { clearStreamingCaret } from "./bubbles.js";
import { registerHiddenBody, registerReveal } from "./reveal.js";
import { st, type ThinkingCard, type ToolCard, type WorkBlock } from "./state.js";
import { restoreToolScroll } from "./view-state.js";

const t = getDict();

/* ---------------------------------------------------------------- */
/* 执行过程块 + 可折叠卡片（思考、工具）                             */
/* ---------------------------------------------------------------- */

/** 由宿主设置（`showThinking` 消息）；语义见 state.ts。 */
export function setShowThinking(enabled: boolean): void {
  st.showThinking = enabled;
}

/**
 * 创建或复用当前的非正式输出组。组本身留在 transcript 顶层，
 * 卡片放在它的 `body` 里。
 */
export function ensureWorkBlock(): WorkBlock {
  if (st.activeWorkBlock) return st.activeWorkBlock;
  // 出现工具活动即 agent 已停止说话；运行虽继续，
  // 正在流式的消息已经写完。
  clearStreamingCaret();

  // 位置在这里是稳定身份：同一事件序列无论一次性回放还是实时追加，
  // 分组总是相同。
  const index = ++st.workBlockIndex;
  const work: WorkBlock = {
    collapsible: createCollapsible({
      classes: WORK_CLASSES,
      rootClass: "work-block running",
      tag: "section",
      label: t.workHeader,
      // 视图记忆优先；没有它，块只在 showThinking 开启且实时构建时
      // 展开。回放两种情况都折叠——回放的终态必须与实时运行的终态一致。
      expanded: st.currentView.work.get(index)?.expanded ?? (!st.replaying && st.showThinking),
      parent: st.sink,
    }),
    thinkingCount: 0,
    toolCount: 0,
    failedToolCount: 0,
    activeTools: new Map(),
  };
  updateWorkStatus(work);
  // 摘要之后还有两个头部字段，顺序固定：失败数在前、「此刻在做什么」
  // 在后。`.work-status` 装计数且永不截断；action 排最后，因为它长度
  // 无界（工具/技能名）且尾巴最不重要。失败数若排在尾巴，必须存活的
  // 信息恰好落在省略号吃掉的地方。
  work.collapsible.statusEl.after(el("span", "work-failures"), el("span", "work-action"));
  st.activeWorkBlock = work;
  st.workBlocks.set(index, work.collapsible);
  // 这里没有 hidden-body 文本：执行过程块的 body 是即时填充的，只是被藏起。
  registerReveal(work.collapsible);
  return work;
}

/** 更新执行过程块折叠时显示的紧凑执行摘要。 */
function updateWorkStatus(work: WorkBlock, action?: string): void {
  if (action !== undefined) work.action = action;
  work.collapsible.statusEl.textContent = t.workInProgress(work.thinkingCount, work.toolCount);
  updateWorkFailures(work);
  setWorkField(work, "work-action", work.action ?? "");
}

/** 写入头部尾随字段之一；空文本使字段塌缩。 */
function setWorkField(work: WorkBlock, cls: string, text: string): void {
  const field = work.collapsible.root.querySelector<HTMLElement>(`.${cls}`);
  if (field) field.textContent = text;
}

/** 同步独立的失败计数字段；无失败时为空。 */
function updateWorkFailures(work: WorkBlock): void {
  setWorkField(work, "work-failures", work.failedToolCount ? t.workFailed(work.failedToolCount) : "");
}

/** 标记当前组完成；下一个非正式事件另起新组。 */
export function finishWorkBlock(): void {
  if (!st.activeWorkBlock) return;
  st.activeWorkBlock.collapsible.root.classList.remove("running");
  st.activeWorkBlock.collapsible.root.classList.add("finished");
  updateWorkFailures(st.activeWorkBlock);
  // 块结束后「此刻在做什么」不再有意义。
  setWorkField(st.activeWorkBlock, "work-action", "");
  st.activeWorkBlock.collapsible.statusEl.textContent = t.workDone(st.activeWorkBlock.thinkingCount, st.activeWorkBlock.toolCount);

  // 因 showThinking 而展开的块，过程一结束就收回。不检查子卡片 pin：
  // 「保持块展开」的用户意图已由视图记忆承载（`captureViewState` 记录
  // 实际展开态，切走再切回会恢复），强制收起不丢任何找不回的东西。
  if (st.showThinking && !st.activeWorkBlock.collapsible.root.classList.contains("collapsed")) {
    st.activeWorkBlock.collapsible.setExpanded(false);
  }
  st.activeWorkBlock = undefined;
}

export function createThinkingCard(streaming: boolean): ThinkingCard {
  const work = ensureWorkBlock();
  work.thinkingCount += 1;
  updateWorkStatus(work, t.workThinking);
  // 先声明后调用：卡片以展开态创建时 `render()` 在 `createCollapsible`
  // 内同步执行，早于 `entry` 赋值一步——那一刻 `entry` 就是 `undefined`。
  let entry: ThinkingCard;
  entry = createCollapsible({
    classes: CARD_CLASSES,
    rootClass: "thinking-card",
    label: streaming ? t.thinkingHeader : t.thinkingDone,
    // showThinking 开启且实时构建时，流运行期间保持展开；
    // 流结束时由 `finishCard()` 收起。
    expanded: !st.replaying && st.showThinking,
    onToggle: () => {
      // 任何手动触碰（无论方向）都把卡片归用户：移出 `autoFoldable`，
      // 之后的流结束/块结束都不得折叠它。
      st.autoFoldable.delete(entry);
    },
    parent: work.collapsible.body,
    render: (body) => body.replaceChildren(renderMarkdown(entry?.raw ?? "")),
  }) as ThinkingCard;
  entry.raw = "";
  if (!st.replaying && st.showThinking) st.autoFoldable.add(entry);
  registerHiddenBody(entry, () => entry.raw);
  if (streaming) entry.root.classList.add("streaming");
  return entry;
}

/** 冻结活动思考卡片：停脉冲、换标签。 */
export function finishThinkingCard(): void {
  if (!st.thinkingCard) return;
  finishCard(st.thinkingCard);
  st.thinkingCard = undefined;
}

export function finishCard(card: ThinkingCard): void {
  card.root.classList.remove("streaming");
  card.labelEl.textContent = t.thinkingDone;
  card.invalidate();
  card.refresh();
  // 由设置自动展开、且从未被用户碰过的卡片，自己的流一结束就自行
  // 收起；不等块的结束。
  if (st.showThinking && st.autoFoldable.has(card)) {
    st.autoFoldable.delete(card);
    card.setExpanded(false);
  }
}

export function startToolCard(id: string, name: string, args: unknown, skill?: SkillRef): void {
  const work = ensureWorkBlock();
  work.toolCount += 1;
  work.activeTools.set(id, name);
  // 历史回放也走这条路，资源面板的「本会话生效」标记因此
  // 同时覆盖回放与实时运行。
  markToolUsed(name);
  updateWorkStatus(work, skill?.kind === "load" ? t.workLoadingSkill(skill.name) : t.workCalling(name));
  const entry = createCollapsible({
    classes: CARD_CLASSES,
    rootClass: "tool-card",
    label: name,
    status: t.running,
    parent: work.collapsible.body,
    render: (body) => {
      renderToolBody(st.toolCards.get(id) ?? entry, body);
      restoreToolScroll(id, body);
    },
  }) as ToolCard;
  entry.root.classList.add("running", "streaming");
  if (skill) markToolCardSkill(entry, skill);
  entry.toolName = name;
  entry.argsText = summarizeArgs(args);
  entry.bodyText = "";
  st.toolCards.set(id, entry);
  // 折叠时 body 永不渲染，其文本（args、输出、patch、details）只有经
  // 这个区域才可搜索；闭包读取的是活的 entry，tool_end 会持续填充。
  registerHiddenBody(entry, () =>
    [entry.argsText, entry.bodyText, entry.patch, flattenDetailText(entry.details)].filter(Boolean).join("\n"));
  // 必须在 entry 存在之后展开：展开会渲染 body，而 body 回读 `entry`。
  // 委派卡片是子代理动态的唯一视图，父级等待时自身无输出：
  // 默认折叠会让窗口看起来冻住。
  if (name === SUBAGENT_TOOL) entry.setExpanded(true);
}

/**
 * 把技能与普通文件访问区分开：模型自行加载技能在 SDK 里就是一次普通
 * 的 SKILL.md `read`，否则与执行过程块里的其他 read 无从分辨。
 */
function markToolCardSkill(entry: ToolCard, skill: SkillRef): void {
  const load = skill.kind === "load";
  entry.root.classList.add(load ? "skill-load" : "skill-resource");
  const badge = el("span", load ? "skill-badge load" : "skill-badge", load ? t.skillLoadBadge(skill.name) : skill.name);
  badge.title = load ? t.skillLoadTitle : t.skillResourceTitle;
  entry.labelEl.appendChild(badge);
  if (load) markSkillActive(skill.name);
}

export function endToolCard(event: Extract<ChatEvent, { kind: "tool_end" }>): void {
  // 历史回放没有前置的 `tool_start`，按需创建卡片。
  if (!st.toolCards.has(event.id)) startToolCard(event.id, event.name, event.args, event.skill);
  const entry = st.toolCards.get(event.id);
  if (!entry) return;

  entry.statusEl.textContent = event.isError ? t.errorLabel : t.done;
  entry.root.classList.remove("running", "streaming");
  entry.root.classList.toggle("error", event.isError);
  entry.bodyText = event.text;
  entry.patch = event.patch;
  entry.path = event.path;
  entry.details = event.details;
  entry.invalidate();
  entry.refresh();

  const work = st.activeWorkBlock;
  if (work) {
    work.activeTools.delete(event.id);
    if (event.isError) work.failedToolCount += 1;
    const activeTool = [...work.activeTools.values()].at(-1);
    updateWorkStatus(work, activeTool ? t.workCalling(activeTool) : t.workLastTool(event.name));
  }
  st.toolCards.delete(event.id);
}

/** 工具卡片完整 body：args 摘要 + 输出文本或 diff + 动作。 */
function renderToolBody(entry: ToolCard, body: HTMLElement): void {
  body.replaceChildren();
  // subagent 卡片用 `details` 而不是结果文本构建：调用运行期间该
  // payload 是各子代理动态的唯一实时视图，父级此刻没有自己的输出。
  if (entry.toolName === SUBAGENT_TOOL && renderLanes(entry, body)) return;
  if (entry.argsText) body.appendChild(el("div", "tool-args", entry.argsText));
  if (entry.patch) {
    const diff = el("div");
    diff.appendChild(renderPatch(entry.patch));
    body.appendChild(diff);
    if (entry.path) {
      const actions = el("div", "tool-actions");
      actions.append(
        button("secondary", t.openDiff, () => post({ type: "openDiff", path: entry.path ?? "", patch: entry.patch ?? "" })),
        button("secondary", t.openFile, () => post({ type: "openFile", path: entry.path ?? "" })),
      );
      body.appendChild(actions);
    }
  } else if (entry.bodyText) {
    body.appendChild(el("pre", "tool-body", truncate(entry.bodyText, MAX_TOOL_OUTPUT_CHARS)));
  }
  if (entry.details !== undefined) renderDetailsBlock(entry.details, body);
}

/**
 * `subagent` 调用的逐子代理行。
 *
 * payload 形状不符时返回 false，卡片退回通用渲染而不是一片空白。
 *
 * 每行携带判断是否介入所需的信息：此刻在做什么、可写哪里、已写哪里、
 * 结束后如何收场。行可点击（打开该子代理的只读 transcript），运行中
 * 的可单独停；其余各路继续，父级仍收到完整汇报。
 */
function renderLanes(entry: ToolCard, body: HTMLElement): boolean {
  const details = entry.details;
  if (details === null || typeof details !== "object" || Array.isArray(details)) return false;
  const raw = (details as Record<string, JsonValue>).lanes;
  if (!Array.isArray(raw) || raw.length === 0) return false;

  const list = el("div", "lane-list");
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const lane = item as Record<string, JsonValue>;
    const status = typeof lane.status === "string" ? lane.status : "running";
    const row = el("div", `lane-row lane-${status}`);

    const head = el("div", "lane-head");
    head.appendChild(el("span", "lane-mark", laneMark(status)));
    const title = typeof lane.title === "string" ? lane.title : "subagent";
    head.appendChild(el("span", "lane-title", title));
    const scope = Array.isArray(lane.scope) ? lane.scope.filter((s): s is string => typeof s === "string") : [];
    if (scope.length > 0) head.appendChild(el("span", "lane-scope", scope.join(", ") || "."));
    row.appendChild(head);

    // 运行中进展行才是重点；结束后由结果取代它。
    const progress = typeof lane.progress === "string" ? lane.progress : undefined;
    const summary = typeof lane.summary === "string" ? lane.summary : undefined;
    const detail = status === "running" ? progress : summary;
    if (detail) row.appendChild(el("div", "lane-detail", truncate(detail, MAX_LANE_DETAIL_CHARS)));

    const written = Array.isArray(lane.writtenFiles)
      ? lane.writtenFiles.filter((f): f is string => typeof f === "string")
      : [];
    if (written.length > 0) {
      const label = status === "completed" ? t.laneWrote(written.length) : t.laneWroteBeforeStopping(written.length);
      row.appendChild(el("div", "lane-files", `${label}: ${written.join(", ")}`));
    }
    const violations = typeof lane.scopeViolations === "number" ? lane.scopeViolations : 0;
    if (violations > 0) row.appendChild(el("div", "lane-warning", t.laneScopeRefused(violations)));
    // 给文件清单而不只数量：这是父级要手工收尾的清单，
    // 值得单独一行。
    const denied = Array.isArray(lane.deniedPaths)
      ? lane.deniedPaths.filter((p): p is string => typeof p === "string")
      : [];
    if (denied.length > 0) {
      row.appendChild(el("div", "lane-files", `${t.laneRefusedFiles}: ${denied.join(", ")}`));
    }
    if (lane.bashMayHaveWritten === true) row.appendChild(el("div", "lane-warning", t.laneBashUntracked));

    const actions = el("div", "lane-actions");
    const laneId = typeof lane.id === "string" ? lane.id : undefined;
    const sessionFile = typeof lane.sessionFile === "string" ? lane.sessionFile : undefined;
    if (laneId || sessionFile) {
      // 始终按子代理打开。宿主有活的子会话就用它，否则（窗口重载后）
      // 回放会话文件；但两种方式的标题都保持子代理框架——退化成普通
      // preview 会出现「返回运行中会话」而并无运行。
      actions.append(
        button("secondary", t.laneView, () => post({ type: "showLane", laneId, sessionFile, title })),
      );
    }
    if (status === "running" && laneId) {
      actions.append(button("secondary", t.laneStop, () => post({ type: "stopLane", laneId })));
    }
    if (actions.childElementCount > 0) row.appendChild(actions);
    list.appendChild(row);
  }

  if (list.childElementCount === 0) return false;
  body.appendChild(list);
  return true;
}

function laneMark(status: string): string {
  switch (status) {
    case "completed":
      return "\u2713";
    case "failed":
      return "\u2717";
    case "stopped":
      return "\u25a0";
    default:
      return "\u25cf";
  }
}

/**
 * 工具自带 `details` payload 的通用视图，默认折叠。
 *
 * 工具的 `renderCall`/`renderResult` 只产出 pi-tui 组件（ANSI 行），
 * 其「呈现」无法在这里复用——但背后的数据可以，这里用 webview
 * 自己的方式画它。
 *
 * 有意不认 schema：所有 payload 同一渲染，不给任何扩展特殊待遇。
 * 宿主已限尺寸并剔除不可克隆值（`agent/tool-details.ts`）。
 */
function renderDetailsBlock(details: JsonValue, parent: HTMLElement): void {
  const block = createCollapsible({
    classes: CARD_CLASSES,
    rootClass: "tool-details-block",
    label: t.toolDetails,
    parent,
    render: (target) => appendDetailValue(target, details),
  });
  block.root.title = t.toolDetailsTitle;
  registerHiddenBody(block, () => flattenDetailText(details));
}

/**
 * details payload 的标量值合成一行、不含键——与渲染出的树显示同一份
 * 文本，搜索匹配的就是它。
 */
function flattenDetailText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "object") return String(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  return children
    .map((item) => flattenDetailText(item as JsonValue))
    .filter(Boolean)
    .join(" ");
}

function appendDetailValue(parent: HTMLElement, value: JsonValue): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      parent.appendChild(el("div", "detail-empty", "[]"));
      return;
    }
    value.forEach((item, index) => appendDetailRow(parent, String(index), item));
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      parent.appendChild(el("div", "detail-empty", "{}"));
      return;
    }
    for (const [key, item] of entries) appendDetailRow(parent, key, item);
    return;
  }
  // 根上是裸标量：没有键可配对。
  parent.appendChild(el("div", "detail-value", formatDetailScalar(value)));
}

function appendDetailRow(parent: HTMLElement, key: string, value: JsonValue): void {
  const row = el("div", "detail-row");
  row.appendChild(el("span", "detail-key", key));
  if (value !== null && typeof value === "object") {
    const children = el("div", "detail-children");
    appendDetailValue(children, value);
    row.appendChild(children);
    row.classList.add("nested");
  } else {
    row.appendChild(el("span", "detail-value", formatDetailScalar(value)));
  }
  parent.appendChild(row);
}

/** 字符串不带引号显示；键/值的拆分本身已表达了形状。 */
function formatDetailScalar(value: JsonValue): string {
  return value === null ? "null" : String(value);
}

/** 渲染统一 diff：逐行着色，隐藏文件头。 */
function renderPatch(patch: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = patch.split("\n").filter((line) => !/^(---|\+\+\+|diff |index )/.test(line));
  for (const line of lines.slice(0, MAX_DIFF_LINES)) {
    const row = el("div", "diff-line");
    if (line.startsWith("+")) row.classList.add("added");
    else if (line.startsWith("-")) row.classList.add("removed");
    else if (line.startsWith("@@")) row.classList.add("hunk");
    row.textContent = line || " ";
    fragment.appendChild(row);
  }
  if (lines.length > MAX_DIFF_LINES) {
    fragment.appendChild(el("div", "diff-line hunk", `... ${lines.length - MAX_DIFF_LINES} more lines`));
  }
  return fragment;
}

function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  try {
    return truncate(typeof args === "string" ? args : JSON.stringify(args), MAX_TOOL_ARGS_CHARS);
  } catch {
    return "";
  }
}
