import { getDict } from "./i18n.js";
import { byId, messagesEl, searchBarEl, searchCountEl, searchInputEl } from "./shell.js";

/**
 * Transcript search (Ctrl+F), the GUI counterpart of the TUI's fullscreen
 * transcript search: the query is a literal, case-insensitive,
 * whitespace-normalized string matched against a corpus of the transcript's
 * visible text, and matches are highlighted with next/previous navigation.
 *
 * Two deliberate mechanics:
 *
 * - **The corpus mirrors the TUI's** (`buildSearchCorpus` in pi-tui): every
 *   visible text node is concatenated (a space separates nodes of different
 *   parent elements, like the TUI's span separator), the match runs over the
 *   corpus, and each match maps back to per-node segments. That is what lets
 *   a match span inline markup (`hel<b>lo</b>`) the same way it spans styled
 *   spans in the terminal.
 * - **Highlighting never touches the DOM.** The CSS Custom Highlight API
 *   paints ranges from a registry, so streaming re-renders, markdown
 *   re-parsing and history rebuilds cannot be disturbed by injected `<mark>`
 *   elements, and the smoke snapshot (a DOM serialization) never sees them.
 *   Where the API does not exist (jsdom), matches are still counted and
 *   navigation still runs — only the paint is skipped.
 */

const t = getDict();

/** Chrome 105+. Absent in jsdom: count/navigate still work, paint is skipped. */
const HIGHLIGHT_SUPPORTED = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
const ALL_HIGHLIGHT = "pi-search";
const CURRENT_HIGHLIGHT = "pi-search-current";

interface SearchMatch {
  /** One range per corpus segment the match spans. */
  ranges: Range[];
  /** Element scrolled into view when the match becomes current. */
  anchor: Element;
}

let matches: SearchMatch[] = [];
let currentIndex = -1;
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;

export function isSearchOpen(): boolean {
  return !searchBarEl.classList.contains("hidden");
}

export function openSearch(): void {
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
/* Corpus                                                            */
/* ---------------------------------------------------------------- */

/** Text the user cannot see is not searched (TUI parity: rendered lines only). */
function isSearchableText(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent || !node.data) return false;
  if (parent.closest(".hidden")) return false;
  // Collapsed collapsible bodies are display:none.
  if (parent.closest(".collapsed > .card-body, .collapsed > .work-body")) return false;
  // Bubble footers are chrome (fold toggle label), not conversation.
  if (parent.closest(".bubble-footer")) return false;
  return true;
}

interface Corpus {
  text: string;
  /** Per corpus character: the text node and offset it came from. */
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
    // Text nodes of one parent belong to the same inline run; anything else
    // gets a space, like the TUI corpus' span separator.
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
/* Matching                                                          */
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
    const corpus = buildCorpus();
    const haystack = corpus.text.toLowerCase();
    const expression = new RegExp(escapeRegExp(query), "gu");
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
  }
  // Stay at "no current match" until the user navigates: typing must not
  // yank the scroll position, and the first Enter then lands on match one.
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
/* Highlight paint                                                   */
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
/* Navigation                                                        */
/* ---------------------------------------------------------------- */

function setCurrent(index: number, scroll = true): void {
  currentIndex = ((index % matches.length) + matches.length) % matches.length;
  const current = matches[currentIndex];
  if (scroll && current) {
    current.anchor.scrollIntoView?.({ block: "center" });
  }
  paint();
  renderCount();
}

/* ---------------------------------------------------------------- */
/* Wiring                                                            */
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

/** Streaming, history replays and lane switches all land here as DOM edits. */
new MutationObserver(() => {
  if (isSearchOpen()) scheduleRebuild();
}).observe(messagesEl, { subtree: true, childList: true, characterData: true });
