import { collectHiddenBodies, revealTranscriptElement } from "./transcript.js";
import { getDict } from "./i18n.js";
import { byId, messagesEl, searchBarEl, searchCountEl, searchInputEl } from "./shell.js";

/**
 * transcript 搜索（header 按钮）：字面量、忽略大小写、空白归一的查询，
 * 匹配可前后导航。机制分三层：
 * - DOM 语料镜像 TUI 的做法（pi-tui 的 `buildSearchCorpus`）：拼接全部文本
 *   节点、跨父元素以空格分隔，匹配映射回逐节点片段，因此能跨内联标记
 *   （`hel<b>lo</b>`）；折叠的卡片与气泡也算语料——文本仍在 DOM，导航
 *   时展开。
 * - 从未渲染的懒卡片体走数据层（transcript.ts 的 `collectHiddenBodies`），
 *   命中锚在卡片根上。
 * - 导航即揭示：命中隐藏区时展开工作块与卡片（`revealTranscriptElement`），
 *   重建语料后重新落到其中首个可见命中；嵌套 details 顺路注册自己的区域，
 *   下一次 Enter 再开那一层。
 * 高亮不碰 DOM：CSS Custom Highlight API 从注册表画 Range，流式重渲染、
 * markdown 重解析与历史重建都不会被打扰，DOM 快照也看不到它；API 缺席
 * 时（jsdom）仍可计数与导航，只是不绘制。
 */

const t = getDict();

/** Chrome 105+ 才有；jsdom 没有：计数与导航照常，只是不绘制。 */
const HIGHLIGHT_SUPPORTED = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
const ALL_HIGHLIGHT = "pi-search";
const CURRENT_HIGHLIGHT = "pi-search-current";

interface SearchMatch {
  /** 命中跨越的每个语料段各一个 Range；数据层命中为空。 */
  ranges: Range[];
  /** 该命中成为当前项时滚入视野的元素。 */
  anchor: Element;
  /** 数据层命中的卡片根：揭示前没有 DOM。 */
  root?: HTMLElement;
}

let matches: SearchMatch[] = [];
let currentIndex = -1;
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
/** 一次性标志：揭示路径自己会重建，观察者的后续重建是多余的。 */
let suppressObserverRebuild = false;

export function isSearchOpen(): boolean {
  return !searchBarEl.classList.contains("hidden");
}

function openSearch(): void {
  searchBarEl.classList.remove("hidden");
  searchInputEl.focus();
  searchInputEl.select();
  rebuild();
}

export function closeSearch(): void {
  searchBarEl.classList.add("hidden");
  matches = [];
  currentIndex = -1;
  paint();
}

export function toggleSearch(): void {
  if (isSearchOpen()) closeSearch();
  else openSearch();
}

/* ---------------------------------------------------------------- */
/* 语料 */
/* ---------------------------------------------------------------- */

/** 页面切换隐藏的内容不参与搜索；折叠的卡片与气泡参与——见模块头说明。 */
function isSearchableText(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent || !node.data) return false;
  if (parent.closest(".hidden")) return false;
  // 气泡 footer 是界面部件（折叠开关文案），不是对话内容。
  if (parent.closest(".bubble-footer")) return false;
  return true;
}

interface Corpus {
  text: string;
  /** 按语料字符记录：它来自哪个文本节点及偏移。 */
  source: Array<{ node: Text; offset: number } | undefined>;
}

function buildCorpus(): Corpus {
  const corpus: Corpus = { text: "", source: [] };
  const walker = document.createTreeWalker(messagesEl, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (isSearchableText(node as Text) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  let lastParent: Element | null = null;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const node = current as Text;
    // 同一父元素的文本节点属同一段内联文本；否则补一个空格，对应 TUI
    // 语料的 span 分隔。
    if (corpus.text.length > 0 && node.parentElement !== lastParent) {
      corpus.text += " ";
      corpus.source.push(undefined);
    }
    lastParent = node.parentElement;
    for (let index = 0; index < node.data.length; index++) {
      corpus.text += node.data[index];
      corpus.source.push({ node, offset: index });
    }
  }
  return corpus;
}

/* ---------------------------------------------------------------- */
/* 匹配 */
/* ---------------------------------------------------------------- */

function normalizeQuery(query: string): string {
  return query.replace(/\s+/gu, " ").trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rebuild(): void {
  if (!isSearchOpen()) return;
  const query = normalizeQuery(searchInputEl.value).toLowerCase();
  matches = [];
  currentIndex = -1;
  if (query) {
    const expression = new RegExp(escapeRegExp(query), "gu");
    const corpus = buildCorpus();
    const haystack = corpus.text.toLowerCase();
    for (const hit of haystack.matchAll(expression)) {
      if (hit.index === undefined) continue;
      const start = hit.index;
      const end = start + hit[0].length;
      const ranges: Range[] = [];
      let active: Range | undefined;
      let activeNode: Text | undefined;
      for (let index = start; index < end; index++) {
        const span = corpus.source[index];
        if (!span) {
          active = undefined;
          activeNode = undefined;
          continue;
        }
        if (active && activeNode === span.node) {
          active.setEnd(span.node, span.offset + 1);
        } else {
          active = document.createRange();
          active.setStart(span.node, span.offset);
          active.setEnd(span.node, span.offset + 1);
          ranges.push(active);
          activeNode = span.node;
        }
      }
      const anchor = ranges[0]?.startContainer.parentElement;
      if (ranges.length > 0 && anchor) matches.push({ ranges, anchor });
    }
    // 从未渲染的懒卡片体：匹配其数据层文本并锚在卡片根上。不带 Range
    // ——导航展开卡片、语料收进渲染文本后，高亮自然出现。
    for (const region of collectHiddenBodies()) {
      const regionHaystack = region.text.toLowerCase();
      for (const hit of regionHaystack.matchAll(expression)) {
        if (hit.index === undefined) continue;
        matches.push({ ranges: [], anchor: region.root, root: region.root });
      }
    }
    // 两个来源混合后，遍历序与注册序只是近似文档序；按 anchor 排序，
    // 前后导航才能自上而下。
    matches.sort((a, b) => {
      if (a.anchor === b.anchor) return 0;
      return a.anchor.compareDocumentPosition(b.anchor) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }
  // 用户导航前保持「无当前命中」：输入不得拽动滚动位置，首次 Enter 落
  // 在第一条命中。
  paint();
  renderCount();
}

function renderCount(): void {
  if (!normalizeQuery(searchInputEl.value)) {
    searchCountEl.textContent = "";
  } else if (matches.length === 0) {
    searchCountEl.textContent = t.searchNoResults;
  } else if (currentIndex < 0) {
    searchCountEl.textContent = String(matches.length);
  } else {
    searchCountEl.textContent = t.searchMatchCount(currentIndex + 1, matches.length);
  }
}

/* ---------------------------------------------------------------- */
/* 高亮绘制 */
/* ---------------------------------------------------------------- */

function paint(): void {
  if (!HIGHLIGHT_SUPPORTED) return;
  const registry = CSS.highlights;
  if (matches.length === 0) {
    registry.delete(ALL_HIGHLIGHT);
    registry.delete(CURRENT_HIGHLIGHT);
    return;
  }
  registry.set(ALL_HIGHLIGHT, new Highlight(...matches.flatMap((match) => match.ranges)));
  const current = matches[currentIndex];
  if (current) registry.set(CURRENT_HIGHLIGHT, new Highlight(...current.ranges));
  else registry.delete(CURRENT_HIGHLIGHT);
}

/* ---------------------------------------------------------------- */
/* 导航 */
/* ---------------------------------------------------------------- */

function setCurrent(index: number, scroll = true): void {
  if (matches.length === 0) return;
  // Enter/prev/next 只走一步，环绕在这统一处理，不在各调用点做。
  const wrapped = ((index % matches.length) + matches.length) % matches.length;
  const target = matches[wrapped];
  if (!target) return;
  // 隐藏区命中还没有 DOM：展开它的卡片与所有折叠祖先，待正文渲染后重建
  // 语料，重新落到正文里首个可见命中。
  if (target.root) {
    // 我们自己的重建刚消化过这些变更；观察者再跑一次只会多余地重置当前命中。
    suppressObserverRebuild = true;
    const body = revealTranscriptElement(target.root);
    rebuild();
    const landed = matches.findIndex((match) => !match.root && body !== undefined && body.contains(match.anchor));
    if (landed >= 0) {
      setCurrent(landed, scroll);
      return;
    }
    // 命中的可能是渲染后不逐字存活的文本（markdown 语法、此刻才注册的
    // 嵌套块 details）：退而求其次把卡片带到屏幕上，下一次 Enter 再落到
    // 其中的首个可见命中。
    currentIndex = -1;
    if (scroll) target.root.scrollIntoView?.({ block: "center" });
    paint();
    renderCount();
    return;
  }
  // DOM 命中也要先展开折叠的祖先（及折叠的气泡），anchor 才能滚入视野。
  revealTranscriptElement(target.anchor);
  currentIndex = wrapped;
  if (scroll) {
    target.anchor.scrollIntoView?.({ block: "center" });
  }
  paint();
  renderCount();
}

/* ---------------------------------------------------------------- */
/* 接线 */
/* ---------------------------------------------------------------- */

function scheduleRebuild(): void {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 100);
}

searchInputEl.addEventListener("input", scheduleRebuild);
searchInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    if (matches.length === 0) return;
    if (currentIndex < 0) setCurrent(event.shiftKey ? matches.length - 1 : 0);
    else setCurrent(currentIndex + (event.shiftKey ? -1 : 1));
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeSearch();
  }
});
byId<HTMLButtonElement>("search-prev").addEventListener("click", () => {
  if (matches.length > 0) setCurrent(currentIndex < 0 ? matches.length - 1 : currentIndex - 1);
});
byId<HTMLButtonElement>("search-next").addEventListener("click", () => {
  if (matches.length > 0) setCurrent(currentIndex + 1);
});
byId<HTMLButtonElement>("search-close").addEventListener("click", () => closeSearch());

/** 流式输出、历史重放、lane 切换最终都落为 DOM 变更。 */
new MutationObserver(() => {
  if (!isSearchOpen()) return;
  if (suppressObserverRebuild) {
    suppressObserverRebuild = false;
    return;
  }
  scheduleRebuild();
}).observe(messagesEl, { subtree: true, childList: true, characterData: true });
