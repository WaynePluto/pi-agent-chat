import { el } from "./dom.js";
import { formatTokens } from "./format.js";
import { getDict } from "./i18n.js";
import { statusLineEl } from "./shell.js";
import { state } from "./store.js";

/** Bottom line mirroring the pi CLI footer: tokens, cache, cost, context. */

const t = getDict();

export function renderStatusLine(): void {
  statusLineEl.replaceChildren();
  statusLineEl.classList.remove("hidden");

  if (state.error) {
    statusLineEl.appendChild(el("div", "statusline-row error", state.error));
    return;
  }
  if (!state.ready) {
    statusLineEl.appendChild(el("div", "statusline-row", t.starting));
    return;
  }

  const stats = state.stats;
  if (!stats) return;
  const parts: string[] = [
    `\u2191${formatTokens(stats.inputTokens)} \u2193${formatTokens(stats.outputTokens)}`,
    `R${formatTokens(stats.cacheRead)} W${formatTokens(stats.cacheWrite)}`,
  ];
  if (stats.cacheHitPercent !== undefined) parts.push(`CH${stats.cacheHitPercent.toFixed(1)}%`);
  parts.push(`$${stats.cost.toFixed(3)}`);
  if (stats.contextPercent !== undefined && stats.contextWindow) {
    parts.push(`${stats.contextPercent.toFixed(1)}%/${formatTokens(stats.contextWindow)}`);
  }

  const row = el("div", "statusline-row");
  row.append(el("span", undefined, parts.join("  ")));
  statusLineEl.appendChild(row);
  updateStatusLineFit();
}

/**
 * Drop the whole line when the panel is too narrow for it.
 *
 * These counters only make sense read as a set, so a truncated "↑12k ↓678 R1..."
 * is worse than nothing: it costs a row of height and tells the user less than
 * the transcript above it would.
 */
export function updateStatusLineFit(): void {
  const row = statusLineEl.firstElementChild as HTMLElement | null;
  if (!row) return;
  // Measure unhidden, otherwise the row has no size to compare.
  statusLineEl.classList.remove("hidden");
  if (statusLineEl.offsetParent === null) return;
  statusLineEl.classList.toggle("hidden", row.scrollWidth > row.clientWidth + 1);
}
