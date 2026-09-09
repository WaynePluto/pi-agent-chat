import type { TranscriptImage } from "../../shared/protocol.js";
import { createMessageBubble, type MessageBubble } from "../bubble.js";
import { button, el, icon } from "../dom.js";
import { post } from "../host.js";
import { BRANCH_ICON, REWIND_ICON, TAG_ICON } from "../icons.js";
import { getDict } from "../i18n.js";
import { markExtensionUsed, markPromptUsed, markSkillActive } from "../resources-view.js";
import { messagesEl } from "../shell.js";
import { smoothScrollTo } from "./smooth-scroll.js";
import { st, type StreamingBubble } from "./state.js";

const t = getDict();

/**
 * 补执行用户读旧内容期间被暂存的折叠。期间被 pin 的气泡保留用户的
 * 决定；气泡不可能重新成为本角色最新一条，因为被暂存的只会是更旧的，
 * 且两个集合都随 transcript 一并清空。
 */
export function flushDeferredFolds(): void {
  if (st.deferredFolds.size === 0) return;
  const pending = [...st.deferredFolds];
  // 先清空再折：折叠收缩内容会再次触发 scroll。
  st.deferredFolds.clear();
  for (const bubble of pending) {
    if (!bubble.pinned) bubble.setFolded(true);
  }
  // 最新消息上方的内容刚变短；继续贴住它。
  if (st.followBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* ---------------------------------------------------------------- */
/* 气泡                                                             */
/* ---------------------------------------------------------------- */

export function appendBubble(role: string, text: string): HTMLElement {
  const wrapper = el("div", `bubble ${role}`, text);
  st.sink.appendChild(wrapper);
  return wrapper;
}

/**
 * 「回到开头」的滚动：把消息顶部锚定在滚动容器顶部下方一点的位置。直接写
 * `.messages` 的 scrollTop 而不用 `scrollIntoView`——经 rect 差值定位不
 * 依赖 offsetParent 链，也只会动这一个容器。空闲时平滑滚动（固定时长补间，
 * 见 smooth-scroll.ts）；点击即关闭自动跟随（与向上滚轮同权）：既是语义
 * （用户离开了底部），也堵住飞行途中流式 delta 抢先贴底、把动画打断成跳变
 * 的竞态。恢复跟随的出口保持不变（向下滚轮 / End / 跳底按钮 / 发送），
 * 期间自动折叠照常延后。
 */
/** 锚定间距与 transcript 自身的 `--content-pad`（12px）一致：锚定的消息
 * 与滚到最顶时的第一条消息离上缘同远。 */
const START_ANCHOR_GAP_PX = 12;

function scrollToBubbleStart(root: HTMLElement): void {
  st.userWheeledUp = true;
  st.followBottom = false;
  smoothScrollTo(
    Math.max(
      0,
      messagesEl.scrollTop + root.getBoundingClientRect().top - messagesEl.getBoundingClientRect().top - START_ANCHOR_GAP_PX,
    ),
  );
}

export function appendMarkdownBubble(role: string, text: string, extra?: HTMLElement): MessageBubble {
  const index = ++st.bubbleIndex;
  const remembered = st.currentView.bubbles.get(index);
  const bubble = createMessageBubble({
    role,
    text,
    extra,
    folded: remembered,
    onToggle: (folded) => st.currentView.bubbles.set(index, folded),
    onGotoStart: () => scrollToBubbleStart(bubble.root),
  });
  // 刚到的消息才是正在读的，同角色上一条随之折叠——除非用户手动开合过，
  // 用户决定优先于默认。用户正在上方阅读（未跟随）时改为暂存：
  // 见 deferredFolds。
  const previous = st.latestBubbles.get(role);
  if (previous && !previous.pinned) {
    if (st.replaying || st.followBottom) previous.setFolded(true);
    else st.deferredFolds.add(previous);
  }
  st.latestBubbles.set(role, bubble);
  // 两个角色在会话树里都可寻址，都带动作条；宿主给气泡绑定 entry id
  // 之前保持不可见。
  if (role === "user" || role === "assistant") bubble.root.appendChild(entryActionBar(role));
  // 折叠气泡会裁掉内容，搜索必须能展开它。不检查 pin：凌驾于折叠
  // 规则之上的只有用户自己的开合操作。
  st.revealActions.set(bubble.root, () => {
    if (bubble.folded) bubble.setFolded(false);
    return undefined;
  });
  st.sink.appendChild(bubble.root);
  return bubble;
}

/**
 * 用户消息的附件，以缩略图显示在正文下方。
 *
 * 字节已由宿主处理好（转换/缩放），即模型收到的原样。webview CSP
 * 允许 `data:` URL；这里不需要宿主往返。
 */
function imageStrip(images: TranscriptImage[]): HTMLElement {
  const strip = el("div", "bubble-images");
  for (const image of images) {
    const figure = el("span", "bubble-image");
    const img = document.createElement("img");
    img.src = `data:${image.mimeType};base64,${image.data}`;
    img.alt = image.name ?? "";
    if (image.name) img.title = image.name;
    figure.appendChild(img);
    strip.appendChild(figure);
  }
  return strip;
}

/**
 * 用户消息；排队（follow-up）与转向消息带徽章和不同的强调样式，
 * 与立即提交的消息区分开。
 */
export function appendUserBubble(
  text: string,
  mode?: "steer" | "followUp",
  skill?: string,
  prompt?: string,
  extension?: string,
  images?: TranscriptImage[],
): void {
  // 新回合用留白而不是横线开场。两者标记同一边界，但满列宽的线是眼睛
  // 每次滚动都要跨的家具，而右对齐的着色气泡本身已经自证身份。
  // `.turn-open` 是留白的挂载点；排队/转向消息有意排除（它们还浮在
  // 底部等消费，屏幕上的运行不属于它们），transcript 首条消息前面
  // 也没有东西可分隔。
  const opensTurn = !mode && st.sink.childElementCount > 0;
  const wrapper = appendMarkdownBubble("user", text, images?.length ? imageStrip(images) : undefined).root;
  if (opensTurn) wrapper.classList.add("turn-open");
  // 提示词模板在 agent 运行前展开、扩展命令在运行前被消费，都不会留下
  // 工具卡片。宿主从提交的原文解析它们；在此点亮对应资源行，方式同
  // 模型主动加载技能。
  if (prompt) markPromptUsed(prompt);
  if (extension) {
    markExtensionUsed(extension);
    // 扩展命令永远进不了会话文件，宿主的 `bubbleEntryIds` 对这个气泡
    // 没有条目。打上标记让 `assignEntryIds` 按位置映射时跳过它——
    // 否则其后每个气泡都错位一格，最新的用户消息会丢动作按钮。
    wrapper.dataset.noEntry = "";
  }
  if (skill) {
    // `/skill:<name>` 在 agent 运行前被 SDK 展开，不会有工具卡片报告它；
    // 改为给气泡打标记，并像模型主动加载那样点亮资源面板里的技能。
    wrapper.classList.add("skill");
    const badge = el("span", "bubble-badge skill-invocation", t.skillInvokedBadge);
    badge.title = t.skillInvokedTitle;
    bubbleBadgeColumn(wrapper).appendChild(badge);
    markSkillActive(skill);
  }
  if (!mode) return;
  wrapper.classList.add(mode === "steer" ? "steered" : "queued");
  // 运行状态是主徽章，保持在技能徽章上方。
  bubbleBadgeColumn(wrapper).prepend(el("span", "bubble-badge", mode === "steer" ? t.steerBadge : t.queuedBadge));
  st.pendingUserBubbles.push({ element: wrapper, text, mode });
}

function bubbleBadgeColumn(bubble: HTMLElement): HTMLElement {
  const existing = bubble.querySelector<HTMLElement>(":scope > .bubble-badges");
  if (existing) return existing;
  const column = el("div", "bubble-badges");
  bubble.prepend(column);
  return column;
}

/**
 * 每条消息的会话树动作，宿主告知其 entry（见 `assignEntryIds`）后
 * hover 显示在气泡旁。用户气泡放在左侧留白，agent 气泡放在右侧留白，
 * 动作条绝不压住正文。
 *
 * 「回溯」最常用：在用户消息上把会话退回它并送回输入框，失败重跑
 * （可换模型）就靠它；在回答上则退回那条回答。会话文件只追加，
 * 被放弃的分支仍在、仍可从树导航抵达。
 */
function entryActionBar(role: "user" | "assistant"): HTMLElement {
  const bar = el("div", "bubble-actions");
  const reply = role === "assistant";
  bar.append(
    entryActionButton("switch", REWIND_ICON, t.entrySwitch, reply ? t.entrySwitchReplyTitle : t.entrySwitchTitle),
    entryActionButton("fork", BRANCH_ICON, t.entryFork, reply ? t.entryForkReplyTitle : t.entryForkTitle),
    entryActionButton("label", TAG_ICON, t.entryLabel, t.entryLabelTitle),
  );
  return bar;
}

function entryActionButton(
  action: "switch" | "fork" | "label",
  svg: string,
  label: string,
  title: string,
): HTMLButtonElement {
  const element = button(`bubble-action ${action}`, undefined, (event) => {
    const entryId = (event.currentTarget as HTMLElement).closest<HTMLElement>(".bubble")?.dataset.entryId;
    if (entryId) post({ type: "entryAction", action, entryId });
  });
  element.appendChild(icon(svg));
  // 纯图标按钮：名字留在 tooltip 与屏幕阅读器里。
  element.title = `${label} — ${title}`;
  element.setAttribute("aria-label", label);
  return element;
}

/**
 * 把屏上的消息气泡按序绑定到会话条目。
 *
 * 宿主按角色发送它认可 actionable 的气泡的 id；超出的（仍在排队的
 * 消息、仍在流式的回答、只读 transcript 里的气泡）不绑定、不显动作。
 * 扩展命令气泡被跳过（`data-no-entry`）：它没有会话条目，计入会让
 * 后续气泡索引全部错位、动作被藏。
 */
export function assignEntryIds(
  ids: string[],
  labels: (string | undefined)[],
  assistantIds: string[],
  assistantLabels: (string | undefined)[],
): void {
  bindEntryIds(".bubble.user", ids, labels);
  bindEntryIds(".bubble.assistant", assistantIds, assistantLabels);
}

function bindEntryIds(selector: string, ids: string[], labels: (string | undefined)[]): void {
  const bubbles = [...messagesEl.querySelectorAll<HTMLElement>(selector)].filter(
    (bubble) => bubble.dataset.noEntry === undefined,
  );
  bubbles.forEach((bubble, index) => {
    const id = ids[index];
    if (id) bubble.dataset.entryId = id;
    else delete bubble.dataset.entryId;
    const label = id ? labels[index] : undefined;
    const existing = bubble.querySelector(".label-badge");
    if (!label) {
      existing?.remove();
      return;
    }
    if (existing) existing.textContent = label;
    else {
      const badge = el("span", "bubble-badge label-badge", label);
      const column = bubble.querySelector<HTMLElement>(":scope > .bubble-badges");
      if (column) column.prepend(badge);
      else bubble.prepend(badge);
    }
  });
}

/**
 * transcript 不是 live 会话的稳定可编辑视图（运行中、子代理、preview）
 * 时，隐藏全部逐消息动作。
 */
export function setEntryActionsLocked(locked: boolean): void {
  messagesEl.classList.toggle("actions-locked", locked);
}

export function normalizeUserBubble(element: HTMLElement): void {
  element.classList.remove("queued", "steered");
  const column = element.querySelector<HTMLElement>(":scope > .bubble-badges");
  column?.querySelector(":scope > .bubble-badge:not(.label-badge):not(.skill-invocation)")?.remove();
  if (column && column.childElementCount === 0) column.remove();
}

/**
 * 撤回：排队消息已回到输入框，其漂浮气泡从 transcript 整体消失
 * （与 CLI 的 dequeue 行为一致）。
 */
export function removePendingBubbles(): void {
  for (const pending of st.pendingUserBubbles) pending.element.remove();
  st.pendingUserBubbles.length = 0;
}

/** 是否仍有等待消费的排队/转向气泡。 */
export function hasPendingBubbles(): boolean {
  return st.pendingUserBubbles.length > 0;
}

/**
 * 光标属于具体某一条消息——正在接收 delta 的那个气泡——而不属于
 * 「会话在忙」。两者是不同事实：agent 停止说话开始调工具后，运行
 * 仍在流式，但这条消息已写完，留着光标就是在宣称文字还在长。
 */
export function clearStreamingCaret(): void {
  st.liveBubbleEl?.classList.remove("streaming");
  st.liveBubbleEl = undefined;
}

export function createStreamingBubble(role: string): StreamingBubble {
  const bubble = appendMarkdownBubble(role, "");
  if (role === "assistant") {
    clearStreamingCaret();
    st.liveBubbleEl = bubble.root;
    st.liveBubbleEl.classList.add("streaming");
  }
  return { bubble, raw: "" };
}
