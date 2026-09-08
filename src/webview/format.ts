/** transcript、会话页与状态行共用的显示格式化。 */

/** 截断时显式标注「还有 N 字符」，而不是无声切断。 */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n... (${text.length - max} more chars)` : text;
}

/** CLI 风格 footer 的紧凑 token 计数：1234 -> 1.2k，2000000 -> 2.0M。 */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

/* 显示上限。长内容截断而非丢弃：完整文本仍在会话文件与工具自己的输出里。 */
export const MAX_TOOL_OUTPUT_CHARS = 4000;
export const MAX_DIFF_LINES = 400;
export const MAX_TOOL_ARGS_CHARS = 300;
export const MAX_SESSION_TITLE_CHARS = 120;
export const MAX_NOTICE_HEADER_CHARS = 80;
/** 子代理行保持一眼可扫，而不是自成一个 transcript。 */
export const MAX_LANE_DETAIL_CHARS = 240;
/* 消息气泡只在长到值得时才折成预览：折叠一行消息费一次点击却不省空间。
   预算是一个数——`piAgentChat.transcript.foldLines` 的行阈值——按两种形态
   计：短行堆与无换行长段是同样多的文字，故无换行文本按每行这么多字符
   折算。内置默认 14 行 × 50 字符。 */
export const BUBBLE_FOLD_CHARS_PER_LINE = 50;
/* 流式回答每帧都会重跑语法高亮，整文件级的大块保持纯文本而不是每秒
   切词 60 次。 */
export const MAX_HIGHLIGHT_CHARS = 20_000;
export const MAX_COMMAND_MATCHES = 50;
