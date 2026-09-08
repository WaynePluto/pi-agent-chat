/* 快照序列化：哪些属性与类承载含义，渲染出的 DOM 如何变成可比较的
   文本。`serialize` 只被 `snapshot` 使用，留在本地。 */

/** 承载我们关心的行为的属性；其余都是噪声。 */
const KEPT_ATTRIBUTES = ["id", "class", "title", "placeholder", "disabled", "hidden", "aria-expanded", "aria-pressed", "aria-checked", "type"];
/**
 * 由指针/滚动驱动的装饰类，不是结构。`pi-scrolling` 挂在最近被滚动的
 * 容器上、约 900ms 后摘除，快照里它在不在取决于跑到那一步花了多久——
 * 记进基线就会慢机器挂、快机器过，而行为没有任何变化。
 */
const TRANSIENT_CLASSES = new Set(["pi-scrolling"]);
const SPINNER_FRAMES = /[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f]/g;

function serialize(node, depth = 0, lines = []) {
  const indent = "  ".repeat(depth);
  if (node.nodeType === 3) {
    const text = node.textContent.replace(SPINNER_FRAMES, "\u280b").replace(/\s+/g, " ").trim();
    if (text) lines.push(`${indent}"${text}"`);
    return lines;
  }
  if (node.nodeType !== 1) return lines;

  const tag = node.tagName.toLowerCase();
  if (tag === "svg") {
    lines.push(`${indent}<svg/>`);
    return lines;
  }
  const attributes = KEPT_ATTRIBUTES.filter((name) => node.hasAttribute(name))
    .map((name) => {
      let value = node.getAttribute(name);
      if (name === "class" && value) {
        value = value
          .split(/\s+/)
          .filter((c) => c && !TRANSIENT_CLASSES.has(c))
          .join(" ");
        // 仅在过滤后被清空时才消失；本来就 `class=""` 的元素
        // 序列化结果不变。
        if (!value) return undefined;
      }
      return value === "" ? name : `${name}="${value}"`;
    })
    .filter((entry) => entry !== undefined)
    .join(" ");
  lines.push(`${indent}<${tag}${attributes ? ` ${attributes}` : ""}>`);
  for (const child of node.childNodes) serialize(child, depth + 1, lines);
  return lines;
}

export function snapshot(window) {
  return serialize(window.document.getElementById("root")).join("\n");
}

export async function flush(window) {
  // 快照前先让 requestAnimationFrame / setTimeout(0) 回调（流式重渲染、
  // 补全防抖）跑完。
  await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 5));
}
