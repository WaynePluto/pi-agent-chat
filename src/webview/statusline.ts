import type { ExtensionStatusItem } from "../shared/protocol.js";
import { el } from "./dom.js";
import { formatTokens } from "./format.js";
import { getDict } from "./i18n.js";
import { scrollToEnd } from "./transcript/scroll.js";
import { statusLineEl } from "./shell.js";
import { state } from "./store.js";

/** 底部一行，镜像 pi CLI footer：tokens、缓存、成本、上下文。 */

const t = getDict();

/**
 * 扩展经 `ctx.ui.setStatus` 发布的条目，CLI footer 会把它显示在自己的计数
 * 旁。与 `state` 分开保存：它们走独立通道，且必须在仅刷统计时不被清掉。
 */
let extensionStatuses: ExtensionStatusItem[] = [];

export function renderExtensionStatus(items: ExtensionStatusItem[]): void {
  extensionStatuses = items;
  renderStatusLine();
}

export function renderStatusLine(): void {
  paintStatusLine();
  // 状态行的出现/消失/增减行会压缩 transcript 视口：进入会话时的贴底
  // 发生在宿主发出 extensionStatus / state 之前，此处跟随态补一次。
  scrollToEnd();
}

function paintStatusLine(): void {
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

  // 扩展文本是散文不是计数组，单独占一行：窄了仍可读，也不受下面的
  // 适配规则约束。
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
 * 面板窄到放不下时丢掉计数行。
 *
 * 这些计数只有作为一组读才有意义，截断的「↑12k ↓678 R1...」比没有更糟：
 * 白占一行高度、信息量还不如上面的 transcript。只丢那一行——扩展状态行
 * 是独立文本，保留。
 */
export function updateStatusLineFit(): void {
  const row = statusLineEl.querySelector<HTMLElement>(".statusline-row.stats");
  // 在未隐藏状态测量，否则该行没有可比的尺寸。
  statusLineEl.classList.remove("hidden");
  row?.classList.remove("hidden");
  if (row && statusLineEl.offsetParent !== null) {
    row.classList.toggle("hidden", row.scrollWidth > row.clientWidth + 1);
  }
  // 里面什么都没剩时把整条隐藏，免得被丢掉的计数行在 composer 下方留
  // 一条空带。
  statusLineEl.classList.toggle("hidden", !statusLineEl.querySelector(".statusline-row:not(.hidden)"));
}
