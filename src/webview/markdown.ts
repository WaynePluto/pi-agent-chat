import { marked } from "marked";

import { copyButton } from "./clipboard.js";
import { el } from "./dom.js";
import { highlightCode } from "./highlight.js";
import { getDict } from "./i18n.js";

const t = getDict();

/**
 * Markdown rendering for chat bubbles.
 *
 * The webview CSP already blocks scripts without the nonce, but model output is
 * untrusted input, so the generated HTML is additionally passed through a
 * DOM-level allowlist before it is inserted.
 */

const ALLOWED_TAGS = new Set([
  "A",
  "BLOCKQUOTE",
  "BR",
  "CODE",
  "DEL",
  "EM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "STRONG",
  "TABLE",
  "TBODY",
  "TD",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

const ALLOWED_ATTRIBUTES: Record<string, Set<string>> = {
  A: new Set(["href", "title"]),
  CODE: new Set(["class"]),
  TD: new Set(["align"]),
  TH: new Set(["align"]),
};

const SAFE_LINK = /^(https?:|mailto:)/i;

marked.setOptions({ gfm: true, breaks: true });

/** Render markdown into a sanitized fragment ready to be appended to the DOM. */
export function renderMarkdown(text: string): DocumentFragment {
  const html = marked.parse(text, { async: false });
  const template = document.createElement("template");
  template.innerHTML = html;
  sanitize(template.content);
  decorateCodeBlocks(template.content);
  return template.content;
}

/**
 * Render markdown without syntax highlighting — used during streaming where the
 * text changes every frame and highlighting would be wasted work (fences are
 * usually incomplete anyway). Code blocks still get wrapped and get their copy
 * button, just no color.
 */
export function renderMarkdownNoHighlight(text: string): DocumentFragment {
  const html = marked.parse(text, { async: false });
  const template = document.createElement("template");
  template.innerHTML = html;
  sanitize(template.content);
  decorateCodeBlocksNoHighlight(template.content);
  return template.content;
}

/**
 * Give every fenced code block its own copy button, and color it.
 *
 * `marked` does neither: highlighting is delegated to a `highlight` option that
 * a caller has to supply, and no published extension adds a copy button on its
 * own. Both are done here on the rendered DOM instead — after `sanitize()`,
 * whose allowlist deliberately contains neither the wrapper, nor the button,
 * nor the token spans. That order is the point: the model's output is reduced
 * to text first, and everything added afterwards is ours.
 */
function decorateCodeBlocks(root: ParentNode): void {
  for (const pre of [...root.querySelectorAll("pre")]) {
    const wrapper = el("div", "code-block");
    pre.replaceWith(wrapper);
    wrapper.append(pre, copyButton("code-copy", t.copyCode, () => pre.textContent ?? ""));
    highlightBlock(pre);
  }
}

/** Same as decorateCodeBlocks but skips highlighting (used during streaming). */
function decorateCodeBlocksNoHighlight(root: ParentNode): void {
  for (const pre of [...root.querySelectorAll("pre")]) {
    const wrapper = el("div", "code-block");
    pre.replaceWith(wrapper);
    wrapper.append(pre, copyButton("code-copy", t.copyCode, () => pre.textContent ?? ""));
  }
}

/** Language of a fenced block, as `marked` records it: `<code class="language-ts">`. */
function highlightBlock(pre: HTMLPreElement): void {
  const code = pre.querySelector("code");
  if (!code) return;
  const language = [...code.classList].find((name) => name.startsWith("language-"))?.slice("language-".length);
  // `textContent` of a sanitized block is plain text, and highlight.js escapes
  // it on the way out, so the result is safe to assign as markup.
  const html = highlightCode(code.textContent ?? "", language);
  if (html === undefined) return;
  code.innerHTML = html;
  code.classList.add("hljs");
}

function sanitize(root: ParentNode): void {
  for (const node of [...root.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE) continue;
    if (node.nodeType !== Node.ELEMENT_NODE) {
      node.remove();
      continue;
    }

    const element = node as Element;
    if (!ALLOWED_TAGS.has(element.tagName)) {
      // Keep the text of unknown elements, drop the element itself.
      const text = document.createTextNode(element.textContent ?? "");
      element.replaceWith(text);
      continue;
    }

    for (const attribute of [...element.attributes]) {
      const allowed = ALLOWED_ATTRIBUTES[element.tagName];
      if (!allowed?.has(attribute.name)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (attribute.name === "href" && !SAFE_LINK.test(attribute.value.trim())) {
        element.removeAttribute("href");
      }
    }

    sanitize(element);
  }
}
