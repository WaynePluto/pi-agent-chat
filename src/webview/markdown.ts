import { marked } from "marked";

import { copyButton } from "./clipboard.js";
import { el } from "./dom.js";
import { highlightCode } from "./highlight.js";
import { getDict } from "./i18n.js";

const t = getDict();

/**
 * 聊天气泡的 Markdown 渲染。
 *
 * webview CSP 已挡掉无 nonce 的脚本，但模型输出是不可信输入，因此生成的
 * HTML 在插入前还要再过一遍 DOM 级白名单。
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

/** 把 markdown 渲染成已净化、可直接挂进 DOM 的 fragment。 */
export function renderMarkdown(text: string): DocumentFragment {
  const html = marked.parse(text, { async: false });
  const template = document.createElement("template");
  template.innerHTML = html;
  sanitize(template.content);
  decorateCodeBlocks(template.content);
  return template.content;
}

/**
 * 渲染 markdown 但不做语法高亮——流式期间文本每帧都变，高亮是浪费（fence
 * 反正常常不完整）。代码块仍会包框并带复制按钮，只是没颜色。
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
 * 给每个 fence 代码块配复制按钮并上色。
 *
 * `marked` 两件都不做：高亮要调用方经 `highlight` 选项提供，复制按钮也没
 * 有现成扩展会加。都在渲染出的 DOM 上做——在 `sanitize()` 之后，而白名单
 * 刻意不含包裹元素、按钮与 token span。顺序就是重点：先把模型输出化简为
 * 文本，之后加的一切都是我们自己的。
 */
function decorateCodeBlocks(root: ParentNode): void {
  for (const pre of [...root.querySelectorAll("pre")]) {
    const wrapper = el("div", "code-block");
    pre.replaceWith(wrapper);
    wrapper.append(pre, copyButton("code-copy", t.copyCode, () => pre.textContent ?? ""));
    highlightBlock(pre);
  }
}

/** 同 decorateCodeBlocks，但跳过高亮（流式期间用）。 */
function decorateCodeBlocksNoHighlight(root: ParentNode): void {
  for (const pre of [...root.querySelectorAll("pre")]) {
    const wrapper = el("div", "code-block");
    pre.replaceWith(wrapper);
    wrapper.append(pre, copyButton("code-copy", t.copyCode, () => pre.textContent ?? ""));
  }
}

/** fence 块的语言，取 `marked` 记录的形式：`<code class="language-ts">`。 */
function highlightBlock(pre: HTMLPreElement): void {
  const code = pre.querySelector("code");
  if (!code) return;
  const language = [...code.classList].find((name) => name.startsWith("language-"))?.slice("language-".length);
  // 净化后的块 `textContent` 是纯文本，highlight.js 输出时会转义，因此
  // 结果可安全赋为 markup。
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
      // 未知元素保留其文本，丢弃元素本身。
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
