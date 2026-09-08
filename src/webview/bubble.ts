/**
 * 正式消息气泡（用户或 agent）。
 *
 * 与曾经的普通 `div` 的两点差别：
 * - **折叠**：不再是该角色最新一条的长消息折成预览，满篇长文的
 *   transcript 仍可导航；短消息永不折叠——省两行却多点一次是纯负担。
 * - **footer**：承载折叠开关与复制原始 Markdown 的按钮，因此渲染内容
 *   单独放在一个元素里而不是直接挂在 `.bubble` 下（裁剪不得吞掉
 *   footer、徽章与 hover 动作条）。
 */

import { copyButton } from "./clipboard.js";
import { button, el } from "./dom.js";
import { BUBBLE_FOLD_CHARS_PER_LINE } from "./format.js";
import { getDict } from "./i18n.js";
import { renderMarkdown, renderMarkdownNoHighlight } from "./markdown.js";
import { DEFAULT_FOLD_LINES } from "../shared/protocol.js";

const t = getDict();

/**
 * 当前生效的折叠阈值，单位行（`piAgentChat.transcript.foldLines`；0 为
 * 不折叠）。初值取文档默认值：尚未收到宿主消息的 webview（冒烟环境、
 * `ready` 还在路上）渲染的就是默认行为；宿主在 `ready` 与每次变更时推送。
 */
let foldMaxLines = DEFAULT_FOLD_LINES;

/** 应用新的折叠阈值；宿主随后会跟一次 history 重放。 */
export function setFoldMaxLines(lines: number): void {
  foldMaxLines = Number.isFinite(lines) ? Math.max(0, Math.round(lines)) : DEFAULT_FOLD_LINES;
}

export interface MessageBubble {
  /** `.bubble` 元素：徽章、动作条与 class 仍然挂在这。 */
  readonly root: HTMLElement;
  /** 当前渲染的原始 Markdown；复制按钮交出的就是它。 */
  readonly text: string;
  /** 长到值得折叠。 */
  readonly foldable: boolean;
  readonly folded: boolean;
  /**
   * 用户已对这个气泡做出决定，自动折叠不再动它——「我展开过的旧消息
   * 就保持展开」。
   */
  readonly pinned: boolean;
  /** 带语法高亮的完整重渲染（用于最终文本）。 */
  setText(text: string): void;
  /**
   * 增量流式渲染：只重解析最后一个稳定块边界之后的尾部；不做语法高亮
   * （fence 尚未闭合）。
   */
  setStreamingText(text: string): void;
  setFolded(folded: boolean): void;
}

export interface MessageBubbleOptions {
  role: string;
  text: string;
  /**
   * 渲染出的 Markdown 与 footer 之间的附加内容，如图片附件。刻意放在
   * `.bubble-content` 之外：折叠裁剪的是那个元素，而附件不属于会折走的
   * 正文。
   */
  extra?: HTMLElement;
  /** 上次浏览这份 transcript 时记住的手动开合状态。 */
  folded?: boolean;
  onToggle?(folded: boolean): void;
}

export function createMessageBubble(options: MessageBubbleOptions): MessageBubble {
  const root = el("div", `bubble markdown ${options.role}`);
  const content = el("div", "bubble-content");
  const footer = el("div", "bubble-footer");
  const toggle = button("bubble-fold", "", () => {
    pinned = true;
    setFolded(!folded);
    options.onToggle?.(folded);
  });

  let text = "";
  let foldable = false;
  let folded = options.folded ?? false;
  let pinned = options.folded !== undefined;

  const applyFold = () => {
    root.classList.toggle("foldable", foldable);
    root.classList.toggle("folded", foldable && folded);
    toggle.textContent = folded ? t.expandMessage : t.collapseMessage;
    toggle.setAttribute("aria-expanded", String(!folded));
  };

  const setFolded = (next: boolean) => {
    folded = next;
    applyFold();
  };

  const setText = (next: string) => {
    text = next;
    // 带高亮的完整渲染：用于最终 / 完整的消息。
    content.replaceChildren(renderMarkdown(next));
    // 完整渲染，重置增量状态。
    stablePrefix = "";
    stableNodes = 0;
    foldable = isLongMessage(next);
    applyFold();
  };

  /**
   * 流式专用的文本清理：补上流尚未送达闭合标记而悬空的行内标记。不补
   * 的话不稳定尾段每帧解析结果都不同——字面 `*` 变粗体、落单反引号在
   * 代码与文本间翻转，每次翻转都挪动下方布局（无空行构造的流式抖动来
   * 源，其尾段按设计每帧重建）。只补成对标记；fence 尾部不动（fence 内
   * 标记语义不同）。仅在渲染时作用于副本：`text` 与最终完整渲染都不变。
   */
  const closeDanglingInline = (src: string): string => {
    if (src.includes("```")) return src;
    if ((src.split("`").length - 1) % 2 === 1) src += "`";
    if ((src.length - src.replace(/\*\*/g, "").length) / 2 % 2 === 1) src += "**";
    if ((src.split("~~").length - 1) % 2 === 1) src += "~~";
    return src;
  };

  /**
   * 增量流式渲染：在结束一个完整 Markdown 块（段落/fence/列表）的最后
   * 一个双换行处切分。稳定前缀只渲染一次，每帧只重解析不稳定尾段；不做
   * 语法高亮（流式 fence 通常不完整）。
   */
  let stablePrefix = "";
  let stableNodes = 0;

  const setStreamingText = (next: string) => {
    text = next;
    // 找最后一个块边界：双换行且其前是完整块。仍未闭合的 fence（奇数个
    // ```）处不得切分。
    const boundary = findStableBoundary(next, stablePrefix.length);
    const prefix = next.slice(0, boundary);
    const tail = next.slice(boundary);

    if (prefix.length > stablePrefix.length) {
      // 新的稳定内容：渲染并追加。
      const newStable = prefix.slice(stablePrefix.length);
      const fragment = renderMarkdownNoHighlight(newStable);
      const newNodeCount = fragment.childNodes.length;
      // 移除旧尾段节点（此前稳定节点之后的所有内容）
      while (content.childNodes.length > stableNodes) {
        content.lastChild!.remove();
      }
      content.appendChild(fragment);
      stablePrefix = prefix;
      stableNodes += newNodeCount;
    } else {
      // 稳定前缀未变：只替换尾段节点。
      while (content.childNodes.length > stableNodes) {
        content.lastChild!.remove();
      }
    }

    // 渲染不稳定尾段（开销小：通常只有一个段落）。
    if (tail) {
      content.appendChild(renderMarkdownNoHighlight(closeDanglingInline(tail)));
    }

    foldable = isLongMessage(next);
    applyFold();
  };

  footer.append(toggle, copyButton("bubble-copy", t.copyMessage, () => text));
  if (options.extra) root.append(content, options.extra, footer);
  else root.append(content, footer);
  setText(options.text);

  return {
    root,
    get text() {
      return text;
    },
    get foldable() {
      return foldable;
    },
    get folded() {
      return folded;
    },
    get pinned() {
      return pinned;
    },
    setText,
    setStreamingText,
    setFolded,
  };
}

/**
 * 找出 `text` 中「到该位置为止的前缀构成完整 Markdown 块」的最后一个位
 * 置（可独立渲染）；不存在安全切点时返回 0。规则：双换行（`\n\n`）是候
 * 选块边界，但前面有奇数个三反引号 fence 时不算（那是在代码块里，
 * `\n\n` 只是内容）；绝不在 `minOffset`（已提交的前缀长度）之前切分——
 * 后退意味着丢弃已渲染的稳定 DOM。
 */
function findStableBoundary(text: string, minOffset: number): number {
  // 扫描整段文本，跟踪到每个候选位置为止 fence 是否开着。
  let boundary = 0;
  let fenceOpen = false;
  let i = 0;
  while (i < text.length) {
    // 识别行首（允许缩进）的三反引号 fence。
    if (i === 0 || text.charCodeAt(i - 1) === 10) {
      let j = i;
      while (j < text.length && text.charCodeAt(j) === 32) j++; // 跳过缩进
      if (text.startsWith("```", j)) {
        fenceOpen = !fenceOpen;
        i = j + 3;
        continue;
      }
    }
    // fence 之外的双换行 = 块边界候选。
    if (!fenceOpen && text.charCodeAt(i) === 10 && i + 1 < text.length && text.charCodeAt(i + 1) === 10) {
      const pos = i + 2; // 双换行之后的位置
      if (pos > minOffset) {
        boundary = pos;
      }
      i += 2;
      continue;
    }
    i++;
  }
  // 没有超出已提交前缀的候选，意思是「这一帧没有新的稳定内容」：调用方
  // 保留现有前缀、其后全按尾段处理。此处若返回 0（修复前的兜底），prefix
  // 变空、tail 变整条消息，无空行构造每帧都在已渲染文本下再追加一份完整
  // 副本——列表/表格/短行流式时剧烈的重复文本闪烁。
  return Math.max(boundary, minOffset);
}

/**
 * 长短按 Markdown 源文本判定而非渲染高度：webview 在无头环境（每个元素
 * 测得 0）与真实屏幕上必须产出同一份 DOM，按测量判定会在两边悄悄分叉。
 */
function isLongMessage(text: string): boolean {
  // 0 是设置的「永不折叠」值：任何消息都不折叠。
  if (foldMaxLines === 0) return false;
  if (text.length > foldMaxLines * BUBBLE_FOLD_CHARS_PER_LINE) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 10) continue;
    lines += 1;
    if (lines > foldMaxLines) return true;
  }
  return false;
}
