import { collectHiddenBodies, revealTranscriptElement } from "./transcript.js";
import { getDict } from "./i18n.js";
import { byId, messagesEl, searchBarEl, searchCountEl, searchInputEl } from "./shell.js";

/**
 * Transcript search (the header button), the GUI counterpart of the TUI's
 * fullscreen transcript search: the query is a literal,
 * case-insensitive, whitespace-normalized string matched against a corpus of
 * the transcript's text, and matches are highlighted with next/previous
 * navigation.
 *
 * Mechanics, in three layers:
 *
 * - **The DOM corpus mirrors the TUI's** (`buildSearchCorpus` in pi-tui):
 *   every text node is concatenated (a space separates nodes of different
 *   parent elements, like the TUI's span separator), the match runs over the
 *   corpus, and each match maps back to per-node segments. That is what lets
 *   a match span inline markup (`hel<b>lo</b>`) the same way it spans styled
 *   spans in the terminal. Collapsed cards and folded messages are part of
 *   it — their text stays in the DOM, and navigation expands them.
 * - **Lazy card bodies that have never rendered are searched through their
 *   data** (`collectHiddenBodies` in transcript.ts): tool output, thinking
 *   text and details payloads exist as data until the card is first expanded,
 *   so such regions match without DOM and anchor on the card root.
 * - **Navigation reveals.** Landing on a hidden-region match expands the work
 *   block, then the card (`revealTranscriptElement`), rebuilds the corpus —
 *   the body text is DOM now — and re-lands on the first visible match inside
 *   it; a details block nested in that body registers its own region on the
 *   way, so the next Enter opens that layer too.
 *
 * Highlighting never touches the DOM: the CSS Custom Highlight API paints
 * ranges from a registry, so streaming re-renders, markdown re-parsing and
 * history rebuilds cannot be disturbed by injected `<mark>` elements, and the
 * smoke snapshot (a DOM serialization) never sees them. Where the API does
 * not exist (jsdom), matches are still counted and navigation still runs —
 * only the paint is skipped.
 */

const t = getDict();

/** Chrome 105+. Absent in jsdom: count/navigate still work, paint is skipped. */
const HIGHLIGHT_SUPPORTED = typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
const ALL_HIGHLIGHT = "pi-search";
const CURRENT_HIGHLIGHT = "pi-search-current";

interface SearchMatch {
  /** One range per corpus segment the match spans; empty for a data-layer hit. */
  ranges: Range[];
  /** Element scrolled into view when the match becomes current. */
  anchor: Element;
  /** Card root of a data-layer hit: no DOM until it is revealed. */
  root?: HTMLElement;
}

let matches: SearchMatch[] = [];
let currentIndex = -1;
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
/** One-shot: the reveal path rebuilds itself, so skip the redundant follow-up. */
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
/* Corpus                                                            */
/* ---------------------------------------------------------------- */

/** What a page switch hides is not searched. Collapsed cards and folded
 * messages are — see the module header. */
function isSearchableText(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent || !node.data) return false;
  if (parent.closest(".hidden")) return false;
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
    // Lazy bodies that never rendered: match their data-layer text and anchor
    // on the card root. No ranges — the highlight appears once navigation has
    // expanded the card and the corpus picks the rendered text up.
    for (const region of collectHiddenBodies()) {
      const regionHaystack = region.text.toLowerCase();
      for (const hit of regionHaystack.matchAll(expression)) {
        if (hit.index === undefined) continue;
        matches.push({ ranges: [], anchor: region.root, root: region.root });
      }
    }
    // Walk order and registration order only approximate document order once
    // the two sources mix; sort by anchor so next/previous run top to bottom.
    matches.sort((a, b) => {
      if (a.anchor === b.anchor) return 0;
      return a.anchor.compareDocumentPosition(b.anchor) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
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
  if (matches.length === 0) return;
  // Enter/prev/next step by one and rely on the wrap here, not at each call site.
  const wrapped = ((index % matches.length) + matches.length) % matches.length;
  const target = matches[wrapped];
  if (!target) return;
  // A hidden-region hit has no DOM yet: open its card and every collapsed
  // ancestor, rebuild now that the body text is rendered, and re-land on the
  // first visible match inside the body.
  if (target.root) {
    // Our own rebuild just ran over these mutations; the observer would only
    // run a second, redundant one that resets the current match.
    suppressObserverRebuild = true;
    const body = revealTranscriptElement(target.root);
    rebuild();
    const landed = matches.findIndex((match) => !match.root && body !== undefined && body.contains(match.anchor));
    if (landed >= 0) {
      setCurrent(landed, scroll);
      return;
    }
    // The hit may be text that does not survive rendering verbatim (markdown
    // syntax, for instance, or the details payload of a nested block that is
    // only now registered): settle for putting the card on screen; the next
    // Enter then lands on the first visible match inside it.
    currentIndex = -1;
    if (scroll) target.root.scrollIntoView?.({ block: "center" });
    paint();
    renderCount();
    return;
  }
  // A DOM hit still needs its collapsed ancestors expanded (and a folded
  // bubble opened) before the anchor can be scrolled into view.
  revealTranscriptElement(target.anchor);
  currentIndex = wrapped;
  if (scroll) {
    target.anchor.scrollIntoView?.({ block: "center" });
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
  if (!isSearchOpen()) return;
  if (suppressObserverRebuild) {
    suppressObserverRebuild = false;
    return;
  }
  scheduleRebuild();
}).observe(messagesEl, { subtree: true, childList: true, characterData: true });
