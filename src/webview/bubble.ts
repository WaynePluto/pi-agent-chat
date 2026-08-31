/**
 * A formal message bubble (user or assistant).
 *
 * Two things separate it from the plain `div` it used to be:
 *
 *  - **Folding.** Long messages fold to a preview once they are no longer the
 *    newest of their role, so a transcript of essays stays navigable. Short
 *    messages never fold: a click that saves two lines is pure friction.
 *  - **A footer** carrying the fold toggle and a copy button for the raw
 *    Markdown, which is why the rendered content lives in its own element
 *    instead of directly under `.bubble` (the clamp must not swallow the
 *    footer, the badges or the hover action bar).
 */

import { copyButton } from "./clipboard.js";
import { button, el } from "./dom.js";
import { BUBBLE_FOLD_CHARS_PER_LINE } from "./format.js";
import { getDict } from "./i18n.js";
import { renderMarkdown, renderMarkdownNoHighlight } from "./markdown.js";
import { DEFAULT_FOLD_LINES } from "../shared/protocol.js";

const t = getDict();

/**
 * Fold threshold currently in effect, in lines
 * (`piAgentChat.transcript.foldLines`; 0 disables folding). Starts at the
 * documented default so a webview that has not heard from the host yet — the
 * smoke harness, or a `ready` message still in flight — renders exactly the
 * default behavior; the host pushes the configured value on `ready` and on
 * every change.
 */
let foldMaxLines = DEFAULT_FOLD_LINES;

/** Apply a new fold threshold. Followed by a history replay from the host. */
export function setFoldMaxLines(lines: number): void {
  foldMaxLines = Number.isFinite(lines) ? Math.max(0, Math.round(lines)) : DEFAULT_FOLD_LINES;
}

export interface MessageBubble {
  /** The `.bubble` element: badges, action bar and classes still go here. */
  readonly root: HTMLElement;
  /** Raw Markdown currently rendered; what the copy button hands out. */
  readonly text: string;
  /** Long enough to be worth folding. */
  readonly foldable: boolean;
  readonly folded: boolean;
  /**
   * The user decided this bubble's state, so automatic folding leaves it
   * alone — "if I expanded an old message, it stays expanded".
   */
  readonly pinned: boolean;
  /** Full re-render with syntax highlighting (used for final text). */
  setText(text: string): void;
  /**
   * Incremental streaming render: only re-parses the tail after the last
   * stable block boundary. No syntax highlighting (fences are incomplete).
   */
  setStreamingText(text: string): void;
  setFolded(folded: boolean): void;
}

export interface MessageBubbleOptions {
  role: string;
  text: string;
  /**
   * Extra content placed between the rendered Markdown and the footer, e.g.
   * image attachments. Deliberately outside `.bubble-content`: folding clips
   * that element, and an attachment is not part of the prose that folds away.
   */
  extra?: HTMLElement;
  /** Remembered manual state from an earlier visit to this transcript. */
  folded?: boolean;
  onToggle?(folded: boolean): void;
}

export function createMessageBubble(options: MessageBubbleOptions): MessageBubble {
  const root = el("div", `bubble markdown ${options.role}`);
  const content = el("div", "bubble-content");
  const footer = el("div", "bubble-footer");
  const toggle = button("bubble-fold", "", () => {
    pinned = true;
    setFolded(!folded);
    options.onToggle?.(folded);
  });

  let text = "";
  let foldable = false;
  let folded = options.folded ?? false;
  let pinned = options.folded !== undefined;

  const applyFold = () => {
    root.classList.toggle("foldable", foldable);
    root.classList.toggle("folded", foldable && folded);
    toggle.textContent = folded ? t.expandMessage : t.collapseMessage;
    toggle.setAttribute("aria-expanded", String(!folded));
  };

  const setFolded = (next: boolean) => {
    folded = next;
    applyFold();
  };

  const setText = (next: string) => {
    text = next;
    // Full render with highlighting: used for final/complete messages.
    content.replaceChildren(renderMarkdown(next));
    // Reset incremental state since this is a full render.
    stablePrefix = "";
    stableNodes = 0;
    foldable = isLongMessage(next);
    applyFold();
  };

  /**
   * Streaming-only text sanitizer: close inline markers left dangling because
   * the stream has not delivered the closing delimiter yet. Without this the
   * unstable tail re-parses differently on every frame — literal `*`s snap
   * into bold spans, stray backticks flip between text and code, and every
   * such flip shifts the whole layout below (the "streaming jitter" seen with
   * lists and other blank-line-free constructs, whose tail is rebuilt every
   * frame by design). Only paired markers are patched; fenced tails are left
   * untouched since marker semantics inside a fence differ. Applied to a copy
   * at render time only: neither `text` nor the final full render changes.
   */
  const closeDanglingInline = (src: string): string => {
    if (src.includes("```")) return src;
    if ((src.split("`").length - 1) % 2 === 1) src += "`";
    if ((src.length - src.replace(/\*\*/g, "").length) / 2 % 2 === 1) src += "**";
    if ((src.split("~~").length - 1) % 2 === 1) src += "~~";
    return src;
  };

  /**
   * Incremental streaming: split at the last double-newline that ends a
   * complete Markdown block (paragraph/fence/list). The stable prefix is
   * rendered once; only the unstable tail is re-parsed on each frame.
   * No syntax highlighting (streaming fences are usually incomplete).
   */
  let stablePrefix = "";
  let stableNodes = 0;

  const setStreamingText = (next: string) => {
    text = next;
    // Find the last block boundary: double newline with a complete block before it.
    // A code fence that is still open (odd number of ```) must not be split.
    const boundary = findStableBoundary(next, stablePrefix.length);
    const prefix = next.slice(0, boundary);
    const tail = next.slice(boundary);

    if (prefix.length > stablePrefix.length) {
      // New stable content: render it and append.
      const newStable = prefix.slice(stablePrefix.length);
      const fragment = renderMarkdownNoHighlight(newStable);
      const newNodeCount = fragment.childNodes.length;
      // Remove the old tail nodes (everything after the previously stable ones)
      while (content.childNodes.length > stableNodes) {
        content.lastChild!.remove();
      }
      content.appendChild(fragment);
      stablePrefix = prefix;
      stableNodes += newNodeCount;
    } else {
      // Same stable prefix: just replace the tail nodes.
      while (content.childNodes.length > stableNodes) {
        content.lastChild!.remove();
      }
    }

    // Render the unstable tail (cheap: usually just one paragraph).
    if (tail) {
      content.appendChild(renderMarkdownNoHighlight(closeDanglingInline(tail)));
    }

    foldable = isLongMessage(next);
    applyFold();
  };

  footer.append(toggle, copyButton("bubble-copy", t.copyMessage, () => text));
  if (options.extra) root.append(content, options.extra, footer);
  else root.append(content, footer);
  setText(options.text);

  return {
    root,
    get text() {
      return text;
    },
    get foldable() {
      return foldable;
    },
    get folded() {
      return folded;
    },
    get pinned() {
      return pinned;
    },
    setText,
    setStreamingText,
    setFolded,
  };
}

/**
 * Find the last position in `text` where the prefix up to that point forms
 * complete Markdown blocks (safe to render independently). Returns 0 if no
 * safe split point exists yet.
 *
 * Rules:
 * - A double newline (`\n\n`) is a potential block boundary.
 * - But not if an odd number of triple-backtick fences precede it (we'd be
 *   inside a code block where `\n\n` is just content).
 * - We never split before `minOffset` (the previously committed prefix length)
 *   since going backwards would require discarding already-rendered stable DOM.
 */
function findStableBoundary(text: string, minOffset: number): number {
  // Count open fences in the entire text up to each candidate position.
  let boundary = 0;
  let fenceOpen = false;
  let i = 0;
  while (i < text.length) {
    // Detect triple-backtick fences at line start (possibly indented).
    if (i === 0 || text.charCodeAt(i - 1) === 10) {
      let j = i;
      while (j < text.length && text.charCodeAt(j) === 32) j++; // skip indent
      if (text.startsWith("```", j)) {
        fenceOpen = !fenceOpen;
        i = j + 3;
        continue;
      }
    }
    // Double newline outside a fence = block boundary candidate.
    if (!fenceOpen && text.charCodeAt(i) === 10 && i + 1 < text.length && text.charCodeAt(i + 1) === 10) {
      const pos = i + 2; // position right after the double newline
      if (pos > minOffset) {
        boundary = pos;
      }
      i += 2;
      continue;
    }
    i++;
  }
  // No candidate beyond the committed prefix means "nothing new became
  // stable this frame" — the caller must keep its existing prefix and treat
  // everything after it as tail. Returning 0 here (the pre-fix fallback) made
  // `prefix` empty and `tail` the ENTIRE message, so every blank-line-free
  // frame re-appended a full copy of the already-rendered text below it:
  // violent duplicated-text flicker while streaming lists/tables/short lines,
  // converging to a single copy only when a later boundary finally committed.
  return Math.max(boundary, minOffset);
}

/**
 * Length is judged on the Markdown source, not on the rendered height: the
 * webview must produce the same DOM headless (where every element measures 0)
 * as it does on screen, and a measured decision would silently differ there.
 */
function isLongMessage(text: string): boolean {
  // 0 is the setting's "never fold" value: no message qualifies.
  if (foldMaxLines === 0) return false;
  if (text.length > foldMaxLines * BUBBLE_FOLD_CHARS_PER_LINE) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 10) continue;
    lines += 1;
    if (lines > foldMaxLines) return true;
  }
  return false;
}
