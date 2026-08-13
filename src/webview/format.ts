/** Display formatting shared by the transcript, the sessions page and the status line. */

/** Truncate with an explicit "N more chars" marker instead of a silent cut. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n... (${text.length - max} more chars)` : text;
}

/** Compact token counts for the CLI-style footer: 1234 -> 1.2k, 2000000 -> 2.0M. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

/* Display limits. Long content is truncated rather than dropped: the full text
   stays available in the session file and in the tool's own output. */
export const MAX_TOOL_OUTPUT_CHARS = 4000;
export const MAX_DIFF_LINES = 400;
export const MAX_TOOL_ARGS_CHARS = 300;
export const MAX_SESSION_TITLE_CHARS = 120;
export const MAX_NOTICE_HEADER_CHARS = 80;
/** One subagent row stays a glance, not a transcript of its own. */
export const MAX_LANE_DETAIL_CHARS = 240;
export const MAX_COMMAND_MATCHES = 50;
