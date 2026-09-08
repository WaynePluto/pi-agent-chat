import type { MessageBubble } from "../bubble.js";
import type { Collapsible } from "../collapsible.js";
import type { JsonValue, SubagentSetup, ToolSetup } from "../../shared/protocol.js";
import { messagesContentEl } from "../shell.js";

/**
 * transcript 渲染器的全部可变状态，由原先的模块级变量收拢为一个对象。
 * 字段名沿用原变量名，其他模块经 `st.<name>` 引用。
 */

/** 流式 assistant 气泡保留原始 markdown，供每个 delta 到达时重渲染。 */
export interface StreamingBubble {
  bubble: MessageBubble;
  raw: string;
}

export interface ThinkingCard extends Collapsible {
  raw: string;
}

export interface WorkBlock {
  collapsible: Collapsible;
  thinkingCount: number;
  toolCount: number;
  failedToolCount: number;
  activeTools: Map<string, string>;
  action?: string;
}

export interface ToolCard extends Collapsible {
  /** 工具名，供有专属 body 的卡片自我识别。 */
  toolName: string;
  argsText: string;
  bodyText: string;
  patch?: string;
  path?: string;
  /** 工具自定义的结构化结果；见 `renderDetailsBlock`。 */
  details?: JsonValue;
}

/**
 * 「怎么看一个 transcript」的全部信息，按 transcript 分别保存。
 *
 * 切走再切回会从头重建 DOM，不记这些的话用户每次瞄一眼子代理就丢一次
 * 阅读位置——而本功能恰恰鼓励频繁这么做。设上限并按 LRU 淘汰：
 * 视图状态不值得为它泄漏整个会话的内存。
 */
export interface TranscriptViewState {
  /** 按位置记录每个执行过程块：是否展开、读到内部哪里。 */
  work: Map<number, { expanded: boolean; scrollTop?: number }>;
  /**
   * 按位置记录用户手动开合过的消息气泡。只记手动决定：其余都遵循
   * 默认规则（每个角色最新一条展开），每次回放重新计算。
   */
  bubbles: Map<number, boolean>;
  /** 消息列表滚动偏移；undefined 表示从未离开过这个 transcript。 */
  scrollTop?: number;
  /** 离开时是否正跟随新输出。 */
  followBottom: boolean;
  /** 工具卡片 body 内部的滚动偏移，按工具调用 id。 */
  toolScroll: Map<string, number>;
}

export interface HiddenBody {
  /** 折叠的 body 元素；首次展开渲染之前为空。 */
  body: HTMLElement;
  getText(): string;
}

export function emptyViewState(): TranscriptViewState {
  return { work: new Map(), bubbles: new Map(), followBottom: true, toolScroll: new Map() };
}

export interface TranscriptState {
  assistantBubble: StreamingBubble | undefined;
  /** 等待 agent 循环消费的排队/转向气泡。 */
  pendingUserBubbles: Array<{ element: HTMLElement; text: string; mode: "steer" | "followUp" }>;
  thinkingCard: ThinkingCard | undefined;
  /** agent 当前正在构建的非正式输出组。 */
  activeWorkBlock: WorkBlock | undefined;
  toolCards: Map<string, ToolCard>;
  renderScheduled: boolean;
  /** 流式期间显示在消息列表末尾的运行指示行。 */
  workingEl: HTMLElement | undefined;
  workingLabelEl: HTMLElement | undefined;
  /** 当前正在接收 delta 的 agent 回合的气泡（如有）。 */
  liveBubbleEl: HTMLElement | undefined;
  transcriptViews: Map<string, TranscriptViewState>;
  currentView: TranscriptViewState;
  /**
   * 屏上 transcript 的执行过程块，按位置索引。
   *
   * 位置是稳定身份：同一事件序列无论一次性回放还是实时追加，
   * 分组结果总是相同。
   */
  workBlocks: Map<number, Collapsible>;
  workBlockIndex: number;
  /**
   * 每个角色最新的正式消息，以及已渲染计数。
   *
   * 计数即气泡的位置，与执行过程块同一种稳定身份；每个角色最新的
   * 气泡保持展开，直到该角色下一条消息接替它。
   */
  latestBubbles: Map<string, MessageBubble>;
  bubbleIndex: number;
  /**
   * 自动折叠被暂存、等用户回到底部再执行的消息气泡。
   *
   * 新消息一到就折叠同角色上一条，只在用户跟随最新输出时是对的：
   * 滚上去时用户正在读更旧的内容，被读的往往恰是规则要折的那条，
   * 字会从眼前消失、下方全部跳位。因此不跟随时只记账不执行，
   * 恢复跟随（跳底按钮、End、发送、滚回底部）时一次性补折。
   * 回放豁免：回放重建整个 transcript，结果不得取决于用户当时
   * 站在哪里。
   */
  deferredFolds: Set<MessageBubble>;
  /**
   * 如何展开屏上一个可折叠物：展开卡片/执行过程块、展开消息气泡。
   * 以根元素为键，transcript 搜索从一个裸 DOM 锚点就能找到它。
   */
  revealActions: WeakMap<HTMLElement, () => HTMLElement | undefined>;
  /**
   * 从未渲染过的懒加载卡片 body 的文本——工具输出、思考、通知、压缩
   * 摘要、details payload——让搜索在展开之前就能命中。折叠不足以入选：
   * body 必须仍为空，因为一旦渲染文本就永久留在 DOM 里（再折叠也不清）。
   * 随 transcript 一并清除。
   */
  hiddenBodies: Map<HTMLElement, HiddenBody>;
  /**
   * 顶层 transcript 节点的挂载点。回放持久化会话期间换成游离 fragment：
   * 直接在活 DOM 里建几百张卡片，浏览器要为每次 append 维护布局。
   */
  sink: HTMLElement | DocumentFragment;
  /** 回放期间抑制逐事件滚动（会强制同步布局）。 */
  replaying: boolean;
  /** 「暂无消息」/「加载中」占位，主动跟踪而不是查询。 */
  placeholderEl: HTMLElement | undefined;
  /** 最近一次 history 带来的标志，供新会话占位复用。 */
  systemPromptOverridden: boolean;
  subagent: SubagentSetup | undefined;
  terminal: ToolSetup | undefined;
  /** 仅当用户在（或接近）底部时才跟随新内容。 */
  followBottom: boolean;
  /**
   * 用户最近一次滚轮向上，且其后没有任何输入取消这个意图。仅凭几何
   * 无法区分「用户逃离」与「我们自己的贴底」：给 scrollTop 赋值同样
   * 触发 scroll，小幅向上滚轮又落在 NEAR_BOTTOM_PX 区内，两者完全
   * 同貌——于是贴底在下一个流式帧又弹回来，视图上下抖动。滚轮事件是
   * scrollTop 赋值永远伪造不了的输入，因此只有它能在任意距离取消跟随。
   */
  userWheeledUp: boolean;
  /**
   * 思考流运行期间是否保持展开（宿主设置 `piAgentChat.transcript.showThinking`，
   * 在 `ready` 与变更时推送）。默认关闭，下列行为全部以它为闸：
   * 关闭时执行过程块与思考卡片照旧折叠开场。
   */
  showThinking: boolean;
  /**
   * 自己的流结束后必须自行折叠的思考卡片。只有被 showThinking 设置
   * 自动展开的卡片才会进来；用户一碰它（无论开还是合）就移出集合，
   * 此后状态归用户——`onToggle` 只在用户点击时触发，程序化的
   * `setExpanded` 不会。
   */
  autoFoldable: WeakSet<ThinkingCard>;
  lastRenderTime: number;
}

export const st: TranscriptState = {
  assistantBubble: undefined,
  pendingUserBubbles: [],
  thinkingCard: undefined,
  activeWorkBlock: undefined,
  toolCards: new Map(),
  renderScheduled: false,
  workingEl: undefined,
  workingLabelEl: undefined,
  liveBubbleEl: undefined,
  transcriptViews: new Map(),
  currentView: emptyViewState(),
  workBlocks: new Map(),
  workBlockIndex: -1,
  latestBubbles: new Map(),
  bubbleIndex: -1,
  deferredFolds: new Set(),
  revealActions: new WeakMap(),
  hiddenBodies: new Map(),
  sink: messagesContentEl,
  replaying: false,
  placeholderEl: undefined,
  systemPromptOverridden: false,
  subagent: undefined,
  terminal: undefined,
  followBottom: true,
  userWheeledUp: false,
  showThinking: false,
  autoFoldable: new WeakSet(),
  lastRenderTime: 0,
};
