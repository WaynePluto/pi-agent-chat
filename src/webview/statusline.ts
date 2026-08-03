import { el } from "./dom.js";
import { formatTokens } from "./format.js";
import { getDict } from "./i18n.js";
import { statusLineEl } from "./shell.js";
import { state } from "./store.js";

/** Bottom line mirroring the pi CLI footer: tokens, cache, cost, context. */

const t = getDict();

export function renderStatusLine(): void {
  statusLineEl.replaceChildren();

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
}
