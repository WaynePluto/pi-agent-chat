import { marked } from "marked";

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
  return template.content;
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
