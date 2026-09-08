import type { RetryOfferState } from "../../shared/protocol.js";
import { CARD_CLASSES, createCollapsible } from "../collapsible.js";
import { button, el, icon } from "../dom.js";
import { MAX_NOTICE_HEADER_CHARS, formatTokens } from "../format.js";
import { post } from "../host.js";
import { RETRY_ICON } from "../icons.js";
import { getDict } from "../i18n.js";
import { renderMarkdown } from "../markdown.js";
import { ensureWorkBlock } from "./cards.js";
import { registerHiddenBody } from "./reveal.js";
import { st } from "./state.js";

const t = getDict();

/**
 * 状态/错误通知。运行域通知（重试、压缩）归入当前执行过程块，折叠成
 * 单行卡片。命令域通知（如 /session 输出）是用户索要的直接结果：
 * 渲染在 transcript 顶层且默认展开。
 *
 * 带动作（`retry`）的通知无论何种 scope 都留在顶层：执行过程块默认
 * 折叠，藏在折叠后面的按钮算不上「提供」。
 */
export function appendNoticeCard(kind: "status" | "error", text: string, scope?: "command", retry?: RetryOfferState): void {
  const command = scope === "command";
  const parent = command || retry ? st.sink : ensureWorkBlock().collapsible.body;
  const firstLine = text.split("\n")[0] ?? "";
  const short = firstLine.length > MAX_NOTICE_HEADER_CHARS ? `${firstLine.slice(0, MAX_NOTICE_HEADER_CHARS)}...` : firstLine;
  // 折叠后面不藏东西：渲染扁平、不可展开的卡片。
  if (short === text) {
    const card = el("div", `notice-card flat ${kind}${retry ? " actionable" : ""}`);
    card.appendChild(el("span", "card-label", text));
    if (retry) card.appendChild(createRetryButton(retry));
    parent.appendChild(card);
    return;
  }
  const card = createCollapsible({
    classes: CARD_CLASSES,
    rootClass: `notice-card ${kind}`,
    label: short,
    expanded: command,
    parent,
    render: (body) => body.replaceChildren(el("pre", "notice-body", text)),
  });
  // 可折叠的头部本身是按钮，动作放在其下独立一行而不是塞进头部。
  if (retry) {
    const actions = el("div", "notice-actions");
    actions.appendChild(createRetryButton(retry));
    card.root.appendChild(actions);
  }
  registerHiddenBody(card, () => text);
}

/**
 * 重发失败的那次请求，而不是手打一句「继续」。
 *
 * 按钮一律按宿主写在通知上的状态绘制，绝不读本地点击状态：transcript
 * 每次回放（切会话、preview、重挂）都从头重建，按钮自己记住的东西到
 * 那时就丢了——而没人重建的卡片会一直声称已结束的重试还在跑。
 *
 * 每次提议只有一击：再次失败的请求会用新的提议收尾，用掉的这次留在
 * 屏上作为它的结局。
 */
function createRetryButton(state: RetryOfferState): HTMLButtonElement {
  const retryButton = button("notice-action", undefined, () => {
    // 乐观更新：宿主以重建的 transcript 应答，按钮此后长什么样由它决定。
    paintRetryButton(retryButton, "running");
    post({ type: "retry" });
  });
  paintRetryButton(retryButton, state);
  return retryButton;
}

function paintRetryButton(retryButton: HTMLButtonElement, state: RetryOfferState): void {
  const label = state === "running"
    ? t.noticeRetrying
    : state === "succeeded"
      ? t.noticeRetrySucceeded
      : state === "failed"
        ? t.noticeRetryFailed
        : t.noticeRetry;
  retryButton.disabled = state !== "offered";
  retryButton.title = state === "offered" ? t.noticeRetryTitle : label;
  retryButton.replaceChildren(icon(RETRY_ICON), el("span", undefined, label));
}

/**
 * transcript 阶段之间的持久检查点。完整对话保持可见，可展开的 body
 * 显示 Pi 此后携带的摘要与最近若干条消息。
 */
export function appendCompactionBoundary(summary: string, tokensBefore: number, estimatedTokensAfter?: number): void {
  const status = estimatedTokensAfter === undefined
    ? t.compactionTokensBefore(formatTokens(tokensBefore))
    : t.compactionTokens(formatTokens(tokensBefore), formatTokens(estimatedTokensAfter));
  const boundary = createCollapsible({
    classes: CARD_CLASSES,
    rootClass: "compaction-boundary",
    tag: "section",
    label: t.compactionBoundary,
    status,
    parent: st.sink,
    render: (body) => {
      body.append(el("p", "compaction-note", t.compactionContextNote));
      if (summary.trim()) {
        const rendered = el("div", "compaction-summary");
        rendered.append(renderMarkdown(summary));
        body.append(el("div", "compaction-summary-label", t.compactionSummary), rendered);
      }
    },
  });
  // 摘要是 body 里唯一值得被搜到的文本；说明文字是样板。
  registerHiddenBody(boundary, () => summary);
}
