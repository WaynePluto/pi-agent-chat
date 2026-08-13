import type { ExtensionStatusItem } from "../shared/protocol.js";
import { el } from "./dom.js";
import { formatTokens } from "./format.js";
import { getDict } from "./i18n.js";
import { statusLineEl } from "./shell.js";
import { state } from "./store.js";

/** Bottom line mirroring the pi CLI footer: tokens, cache, cost, context. */

const t = getDict();

/**
 * Entries published by extensions through `ctx.ui.setStatus`, which the CLI
 * footer shows next to its own counters. Kept separate from `state` because
 * they are pushed on their own channel and must survive a stats-only repaint.
 */
let extensionStatuses: ExtensionStatusItem[] = [];

export function renderExtensionStatus(items: ExtensionStatusItem[]): void {
  extensionStatuses = items;
  renderStatusLine();
}

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

  // Extension text is prose, not a counter set, so it goes on its own row: it
  // stays readable when narrow and is exempt from the fit rule below.
  if (extensionStatuses.length > 0) {
    const row = el("div", "statusline-row extension-status");
    for (const item of extensionStatuses) row.appendChild(el("span", "extension-status-item", item.text));
    statusLineEl.appendChild(row);
  }

  const stats = state.stats;
  if (!stats) {
    updateStatusLineFit();
    return;
  }
  const parts: string[] = [
    `\u2191${formatTokens(stats.inputTokens)} \u2193${formatTokens(stats.outputTokens)}`,
    `R${formatTokens(stats.cacheRead)} W${formatTokens(stats.cacheWrite)}`,
  ];
  if (stats.cacheHitPercent !== undefined) parts.push(`CH${stats.cacheHitPercent.toFixed(1)}%`);
  parts.push(`$${stats.cost.toFixed(3)}`);
  if (stats.contextPercent !== undefined && stats.contextWindow) {
    parts.push(`${stats.contextPercent.toFixed(1)}%/${formatTokens(stats.contextWindow)}`);
  }

  const row = el("div", "statusline-row stats");
  row.append(el("span", undefined, parts.join("  ")));
  statusLineEl.appendChild(row);
  updateStatusLineFit();
}

/**
 * Drop the counter row when the panel is too narrow for it.
 *
 * These counters only make sense read as a set, so a truncated "↑12k ↓678 R1..."
 * is worse than nothing: it costs a row of height and tells the user less than
 * the transcript above it would. Only that row is dropped — an extension status
 * row is independent text and stays.
 */
export function updateStatusLineFit(): void {
  const row = statusLineEl.querySelector<HTMLElement>(".statusline-row.stats");
  // Measure unhidden, otherwise the row has no size to compare.
  statusLineEl.classList.remove("hidden");
  row?.classList.remove("hidden");
  if (row && statusLineEl.offsetParent !== null) {
    row.classList.toggle("hidden", row.scrollWidth > row.clientWidth + 1);
  }
  // Hide the band itself once nothing is left in it, so a dropped counter row
  // does not leave an empty strip under the composer.
  statusLineEl.classList.toggle("hidden", !statusLineEl.querySelector(".statusline-row:not(.hidden)"));
}
