import type { ChatEvent, SubagentSetup, ToolSetup } from "../shared/protocol.js";
import { el } from "./dom.js";
import { getDict } from "./i18n.js";
import { clearResourceHighlights } from "./resources-view.js";
import { messagesContentEl } from "./shell.js";
import { ensureSpinnerRunning, spinner } from "./spinner.js";
import { currentLane, isDelegating, state } from "./store.js";
import { st } from "./transcript/state.js";
import {
  appendBubble,
  appendMarkdownBubble,
  appendUserBubble,
  clearStreamingCaret,
  createStreamingBubble,
  normalizeUserBubble,
} from "./transcript/bubbles.js";
import {
  createThinkingCard,
  endToolCard,
  finishCard,
  finishThinkingCard,
  finishWorkBlock,
  startToolCard,
} from "./transcript/cards.js";
import { appendCompactionBoundary, appendNoticeCard } from "./transcript/notices.js";
import { resumeFollowing, scrollToEnd } from "./transcript/scroll.js";
import { captureViewState, restoreViewState, selectTranscript } from "./transcript/view-state.js";

/**
 * transcript：聊天气泡、非正式输出（思考 + 工具卡片）聚合的「执行过程」块、
 * 状态/错误通知与运行指示行。
 *
 * 实时流式与历史回放共用同一条路径（`applyEvent`），因此恢复的会话
 * 渲染结果与实时会话完全一致。
 *
 * 实现拆分在 `./transcript/` 各模块（state、scroll、view-state、bubbles、
 * cards、notices、reveal）；本模块保留事件入口与胶水代码，并原样
 * re-export 公开面，调用方不受影响。
 */

const t = getDict();

// 拆分模块的公开面，原样 re-export。
export { assignEntryIds, hasPendingBubbles, removePendingBubbles, setEntryActionsLocked } from "./transcript/bubbles.js";
export { setShowThinking } from "./transcript/cards.js";
export { appendNoticeCard } from "./transcript/notices.js";
export { collectHiddenBodies, revealTranscriptElement } from "./transcript/reveal.js";
export { followLatest } from "./transcript/scroll.js";
export { captureViewState } from "./transcript/view-state.js";

/* ---------------------------------------------------------------- */
/* 事件渲染                                                          */
/* ---------------------------------------------------------------- */

export function applyEvent(event: ChatEvent): void {
  switch (event.kind) {
    case "user_message":
      // 用户消息与正式的 agent 文本一样，会结束它前面的执行过程——否则
      // agent 接下来做的事会继续落进气泡上方的那个块。排队/转向消息例外：
      // 它们还浮在底部，屏幕上的运行不属于它们，要等 agent 消费后才
      // 分割 transcript（见 `reconcilePendingBubbles`）。
      if (!event.mode) {
        finishThinkingCard();
        finishWorkBlock();
      }
      appendUserBubble(event.text, event.mode, event.skill, event.prompt, event.extension, event.images);
      break;
    case "assistant_start":
      st.assistantBubble = undefined;
      finishThinkingCard();
      break;
    case "text_delta":
      // 正式的 agent 文本结束当前执行过程块；之后的思考/工具另起新块。
      finishThinkingCard();
      finishWorkBlock();
      st.assistantBubble ??= createStreamingBubble("assistant");
      st.assistantBubble.raw += event.delta;
      scheduleRender();
      break;
    case "thinking_delta":
      st.thinkingCard ??= createThinkingCard(true);
      st.thinkingCard.raw += event.delta;
      st.thinkingCard.invalidate();
      scheduleRender();
      break;
    case "thinking_message": {
      const card = createThinkingCard(false);
      card.raw = event.text;
      card.invalidate();
      finishCard(card);
      st.thinkingCard = undefined;
      break;
    }
    case "assistant_message":
      finishWorkBlock();
      appendMarkdownBubble("assistant", event.text);
      st.assistantBubble = undefined;
      break;
    case "assistant_end":
      // 最终完整渲染带语法高亮（流式期间跳过）。
      if (st.assistantBubble) st.assistantBubble.bubble.setText(st.assistantBubble.raw);
      finishThinkingCard();
      st.assistantBubble = undefined;
      break;
    case "tool_start":
      startToolCard(event.id, event.name, event.args, event.skill);
      break;
    case "tool_update": {
      const card = st.toolCards.get(event.id);
      if (card) {
        if (event.text) card.bodyText = event.text;
        // 仍在运行的工具的实时 payload；委派卡片由它构建，
        // 各子代理行因此能动起来。
        if (event.details !== undefined) card.details = event.details;
        card.invalidate();
        if (card.expanded) scheduleRender();
      }
      break;
    }
    case "tool_end":
      endToolCard(event);
      break;
    case "agent_start":
      st.assistantBubble = undefined;
      break;
    case "agent_end":
      finalizeStreamingBubble();
      finishThinkingCard();
      // 这里只结束一次底层运行；自动重试、压缩与排队续跑
      // 仍可能往同一个执行过程块里加卡片。
      st.assistantBubble = undefined;
      break;
    case "agent_settled":
      finalizeStreamingBubble();
      finishThinkingCard();
      finishWorkBlock();
      st.assistantBubble = undefined;
      // 此刻仍标记为 pending 的气泡都已被消费或丢弃。
      while (st.pendingUserBubbles.length > 0) normalizeUserBubble(st.pendingUserBubbles.pop()!.element);
      break;
    case "queue_update":
      reconcilePendingBubbles(event.steering, event.followUp);
      break;
    case "compaction_boundary":
      finalizeStreamingBubble();
      finishThinkingCard();
      finishWorkBlock();
      st.assistantBubble = undefined;
      appendCompactionBoundary(event.summary, event.tokensBefore, event.estimatedTokensAfter);
      break;
    case "status":
      // 带续跑提议（重试/继续）的通知是一次轮次边界：上一轮请求已
      // definitively 中断，其后内容属于新的一轮。收掉前面的执行过程块，
      // 避免块保持展开/运行样式而下方却叠着通知与后续消息（回放路径没有
      // agent_settled 生命周期事件，不收块就永远开着）。普通状态卡是同一
      // 次运行内部的事件，继续折进当前块。
      if (event.offer) {
        finishThinkingCard();
        finishWorkBlock();
      }
      appendNoticeCard("status", event.text, event.scope, event.offer);
      break;
    case "error":
      appendNoticeCard("error", event.text, event.scope);
      break;
  }
  if (st.placeholderEl) {
    st.placeholderEl.remove();
    st.placeholderEl = undefined;
  }
  // 回放时逐事件滚动会强制读布局；只在结束时滚一次。
  if (!st.replaying) scrollToEnd();
}

/**
 * 回放持久化的 transcript。全部内容先在游离 fragment 里构建、
 * 一次性挂载，长会话只付一次布局成本，而不是每个事件一次。
 */
export function applyHistory(
  events: ChatEvent[],
  live = false,
  systemPromptOverriddenNow = false,
  subagentNow?: SubagentSetup,
  transcriptId?: string,
  terminalNow?: ToolSetup,
): void {
  const started = performance.now();
  st.systemPromptOverridden = systemPromptOverriddenNow;
  st.subagent = subagentNow;
  st.terminal = terminalNow;
  // 顺序重要：`clearMessages()` 要在旧 transcript 拆掉前捕获阅读位置，
  // 切换到新 transcript 必须排在它之后。
  clearMessages();
  selectTranscript(transcriptId);
  const fragment = document.createDocumentFragment();
  st.sink = fragment;
  st.replaying = true;
  try {
    for (const event of events) applyEvent(event);
  } finally {
    st.replaying = false;
    st.sink = messagesContentEl;
  }
  const built = performance.now();
  messagesContentEl.appendChild(fragment);

  if (events.length === 0) appendEmptySessionPlaceholder();
  // 持久化历史没有 agent 生命周期事件，末尾的非正式卡片属于已完成的
  // 执行过程；除非会话仍在流式（如从 preview 返回），此时收块会把
  // 同一个执行过程切成两半。
  if (!live) finishWorkBlock();
  restoreViewState();
  // 每次会话切换打一行：在真实（大）会话上从 webview devtools 发现回放
  // 回归的最便宜手段。transcript id 与恢复状态数写在这里，是因为阅读
  // 位置在往返（父→子→父）后是否存活在 DOM 里看不见，坏了才知道。
  console.log(
    `[pi-agent-chat] history replay: ${events.length} events, transcript ${transcriptId ?? "(none)"}, ${st.currentView.work.size} remembered work block(s), build ${Math.round(built - started)}ms, total ${Math.round(performance.now() - started)}ms`,
  );
}

/**
 * 「用户选中会话」到「历史到达」之间的占位：没有它，宿主加载并解析
 * 会话文件期间旧 transcript 一直留在屏上，看起来像 UI 冻住。
 */
export function showLoading(): void {
  clearMessages();
  const row = el("div", "working-row");
  row.append(spinner(), el("span", undefined, ` ${t.loadingSession}`));
  messagesContentEl.appendChild(row);
  st.placeholderEl = row;
  resumeFollowing();
}

/**
 * 「新建会话」的占位：没有东西要加载，`showLoading()` 的转圈只会一闪
 * 而过。直接渲染空会话消息——随后到达的空历史渲染的是同一个气泡，
 * 到达时屏上不会有任何变化。
 */
export function showNewSession(): void {
  clearMessages();
  appendEmptySessionPlaceholder();
  resumeFollowing();
}

function appendEmptySessionPlaceholder(): void {
  st.placeholderEl = appendBubble("status", t.emptySession(st.systemPromptOverridden, st.subagent, st.terminal));
  st.placeholderEl.classList.add("empty-session");
}

export function clearMessages(): void {
  // DOM 拆掉之前：这是阅读位置还存在的最后时刻。占位符（加载转圈、
  // 空会话气泡）在屏上时跳过：此刻 scrollTop 属于占位符而非任何
  // transcript，而真正的 transcript 在占位符上岗那一刻已经捕获过——
  // 再记一次会把好数据覆盖成 0，切走再切回就落在顶部。
  if (!st.placeholderEl) captureViewState();
  messagesContentEl.innerHTML = "";
  // 运行行随 innerHTML 一同消失。留着变量会让 `updateWorkingIndicator()`
  // 把这个已脱离文档的元素重新挂回去而不是新建——连同那个共享定时器
  // 早已停摆的 spinner（定时器在第一次找不到文档中的 spinner 时就停了），
  // 留下一个永久冻住的 "working..." 动画。
  st.workingEl = undefined;
  st.workingLabelEl = undefined;
  // 它指向的元素已不在文档里；一并清掉，避免下一轮运行去碰游离节点。
  st.liveBubbleEl = undefined;
  st.toolCards.clear();
  st.pendingUserBubbles.length = 0;
  st.assistantBubble = undefined;
  st.thinkingCard = undefined;
  st.activeWorkBlock = undefined;
  // 块按当前渲染的 transcript 编号；它们索引的状态只在
  // transcript 本身变化时才换。
  st.workBlocks.clear();
  st.workBlockIndex = -1;
  st.latestBubbles.clear();
  st.deferredFolds.clear();
  st.bubbleIndex = -1;
  st.hiddenBodies.clear();
  st.placeholderEl = undefined;
  // 技能标记描述的是正在显示的 transcript，随它一起清除。
  clearResourceHighlights();
}

/**
 * 排队/转向消息被 agent 循环消费后就成为对话的正常部分：摘掉徽章与
 * 强调样式，移到自然位置（其后内容之前）。`queue_update` 携带仍在等待
 * 的文本，不在对应队列里的就是已被消费。
 */
function reconcilePendingBubbles(steering: string[], followUp: string[]): void {
  for (let i = st.pendingUserBubbles.length - 1; i >= 0; i -= 1) {
    const pending = st.pendingUserBubbles[i]!;
    const queue = pending.mode === "steer" ? steering : followUp;
    if (queue.includes(pending.text)) continue;
    normalizeUserBubble(pending.element);
    // 锚定在 transcript 当前末尾：后续输出属于这条消息，不能再漂浮。
    // 这也构成边界——其上方的块是被打断的那次运行，收掉它，
    // 让后面的内容另起新块。
    finishThinkingCard();
    finishWorkBlock();
    messagesContentEl.appendChild(pending.element);
    st.pendingUserBubbles.splice(i, 1);
  }
}

/* ---------------------------------------------------------------- */
/* 渲染调度                                                          */
/* ---------------------------------------------------------------- */

/** 流式渲染的最小间隔（ms）。一次 rAF 约 16ms，即跳过 2–3 帧——
 * 视觉不可感知，渲染量降到 1/4。 */
const RENDER_THROTTLE_MS = 60;

/** 每个节流间隔最多重渲染一次流式内容。 */
function scheduleRender(): void {
  if (st.renderScheduled) return;
  st.renderScheduled = true;
  const elapsed = performance.now() - st.lastRenderTime;
  const delay = Math.max(0, RENDER_THROTTLE_MS - elapsed);
  if (delay === 0) {
    requestAnimationFrame(doRender);
  } else {
    setTimeout(() => requestAnimationFrame(doRender), delay);
  }
}

function doRender(): void {
  st.renderScheduled = false;
  st.lastRenderTime = performance.now();
  flushStreaming();
  scrollToEnd();
}

/**
 * 流式结束时的最终完整渲染（带语法高亮）。
 * 供 assistant_end、agent_end、agent_settled、compaction_boundary 使用。
 */
function finalizeStreamingBubble(): void {
  if (st.assistantBubble) st.assistantBubble.bubble.setText(st.assistantBubble.raw);
  for (const card of st.toolCards.values()) card.refresh();
}

function flushStreaming(): void {
  if (st.assistantBubble) st.assistantBubble.bubble.setStreamingText(st.assistantBubble.raw);
  // 折叠的卡片有意保持原文不渲染。
  if (st.thinkingCard) {
    st.thinkingCard.invalidate();
    st.thinkingCard.refresh();
  }
  for (const card of st.toolCards.values()) card.refresh();
}

/* ---------------------------------------------------------------- */
/* 运行指示行                                                        */
/* ---------------------------------------------------------------- */

/** CLI 风格的运行行；子会话活跃时换成专属文案。 */
export function updateWorkingIndicator(): void {
  if (state.isStreaming || state.isCompacting) {
    if (!st.workingEl) {
      st.workingEl = el("div", "working-row");
      st.workingLabelEl = el("span");
      st.workingEl.append(spinner(), st.workingLabelEl);
    } else {
      // 为 `clearMessages()` 修过的 bug 上双保险：无论还有什么会拆走
      // 这一行，回来之后动画不能停死。
      ensureSpinnerRunning();
    }
    if (st.workingLabelEl) {
      const lane = currentLane();
      st.workingLabelEl.textContent = state.isCompacting
        ? ` ${t.compacting}`
        : state.delegation?.role === "parent" && isDelegating()
          ? ` ${t.waitingForSubagent}`
          : lane?.status === "running"
            ? ` ${t.subagentWorking}`
            : ` ${t.streaming}`;
    }
    messagesContentEl.appendChild(st.workingEl); // 重新 append 保证它排在最后
    scrollToEnd();
  } else {
    st.workingEl?.remove();
    st.workingEl = undefined;
    st.workingLabelEl = undefined;
  }
  // 光标与运行行报告的是两件不同的事实，只共享「不再运行」这个方向：
  // settle 的运行必然没有流式回合。点亮光标是 `createStreamingBubble`
  // 的职责，只有它知道是哪一条消息在长。
  if (!state.isStreaming) clearStreamingCaret();
}
