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
import { MAX_UNFOLDED_BUBBLE_CHARS, MAX_UNFOLDED_BUBBLE_LINES } from "./format.js";
import { getDict } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";

const t = getDict();

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
  setText(text: string): void;
  setFolded(folded: boolean): void;
}

export interface MessageBubbleOptions {
  role: string;
  text: string;
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
    content.replaceChildren(renderMarkdown(next));
    foldable = isLongMessage(next);
    applyFold();
  };

  footer.append(toggle, copyButton("bubble-copy", t.copyMessage, () => text));
  root.append(content, footer);
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
    setFolded,
  };
}

/**
 * Length is judged on the Markdown source, not on the rendered height: the
 * webview must produce the same DOM headless (where every element measures 0)
 * as it does on screen, and a measured decision would silently differ there.
 */
function isLongMessage(text: string): boolean {
  if (text.length > MAX_UNFOLDED_BUBBLE_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 10) continue;
    lines += 1;
    if (lines > MAX_UNFOLDED_BUBBLE_LINES) return true;
  }
  return false;
}
