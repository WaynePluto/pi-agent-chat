/**
 * Copy-to-clipboard buttons (message bubbles, code blocks).
 *
 * The write itself is done by the host (`copyText`): `navigator.clipboard` in a
 * webview depends on focus and on permissions that differ between the desktop,
 * remote and browser hosts, while `vscode.env.clipboard` works in all of them.
 * The button therefore acknowledges optimistically — the host surfaces the
 * (rare) failure itself.
 */

import { button, icon } from "./dom.js";
import { post } from "./host.js";
import { getDict } from "./i18n.js";
import { CHECK_ICON, COPY_ICON } from "./icons.js";

const t = getDict();

/** How long the checkmark replaces the copy icon after a click. */
const FEEDBACK_MS = 1200;

/**
 * Icon-only copy button. The text is read at click time, so a bubble that is
 * still streaming copies what it holds now rather than what it held at build.
 */
export function copyButton(className: string, label: string, text: () => string): HTMLButtonElement {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const element = button(`copy-button ${className}`, undefined, () => {
    post({ type: "copyText", text: text() });
    element.classList.add("copied");
    element.replaceChildren(icon(CHECK_ICON));
    element.title = t.copied;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      element.classList.remove("copied");
      element.replaceChildren(icon(COPY_ICON));
      element.title = label;
    }, FEEDBACK_MS);
  });
  element.appendChild(icon(COPY_ICON));
  // Icon-only: the name survives in the tooltip and for screen readers.
  element.title = label;
  element.setAttribute("aria-label", label);
  return element;
}
