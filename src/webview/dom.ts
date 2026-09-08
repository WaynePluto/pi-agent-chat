/**
 * 极简 DOM 构造工具。
 *
 * webview 按项目约定手搓 UI（无框架），`document.createElement` +
 * `className` + `textContent` 曾重复约 70 次。这几个工具让调用点保持一行，
 * 且不引入任何需要学习的抽象。
 */

/** `el("span", "card-label", "text")`——className 与 text 可省略。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** 一个 `type="button"` 的元素，本 UI 所有可点元素都需要它。 */
export function button(className: string, text?: string, onClick?: (event: MouseEvent) => void): HTMLButtonElement {
  const element = el("button", className, text);
  element.type = "button";
  if (onClick) element.addEventListener("click", onClick);
  return element;
}

/**
 * 内联 SVG 图标。markup 是 bundle 里的硬编码常量、绝非模型输出，所以这里
 * 用 `innerHTML` 是安全的。
 */
export function icon(svg: string, className?: string): HTMLSpanElement {
  const element = el("span", className);
  element.innerHTML = svg;
  return element;
}
