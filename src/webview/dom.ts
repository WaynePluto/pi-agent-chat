/**
 * Tiny DOM construction helpers.
 *
 * The webview builds its UI by hand (no framework, by project convention), so
 * `document.createElement` + `className` + `textContent` was repeated ~70 times.
 * These helpers keep call sites to one line without adding any abstraction the
 * reader has to learn.
 */

/** `el("span", "card-label", "text")` — className and text are optional. */
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

/** A `type="button"` element, which is what every clickable in this UI needs. */
export function button(className: string, text?: string, onClick?: (event: MouseEvent) => void): HTMLButtonElement {
  const element = el("button", className, text);
  element.type = "button";
  if (onClick) element.addEventListener("click", onClick);
  return element;
}

/**
 * Inline SVG icon. The markup is a hard-coded constant in the bundle, never
 * model output, so `innerHTML` is safe here.
 */
export function icon(svg: string, className?: string): HTMLSpanElement {
  const element = el("span", className);
  element.innerHTML = svg;
  return element;
}
