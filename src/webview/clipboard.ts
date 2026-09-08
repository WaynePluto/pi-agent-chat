/**
 * 复制到剪贴板的按钮（消息气泡、代码块）。
 *
 * 写入本身由宿主完成（`copyText`）：webview 里的 `navigator.clipboard`
 * 受焦点与权限影响，desktop / remote / 浏览器宿主各不相同，而
 * `vscode.env.clipboard` 处处可用。按钮因此乐观回显——（罕见的）失败由
 * 宿主自己报告。
 */

import { button, icon } from "./dom.js";
import { post } from "./host.js";
import { getDict } from "./i18n.js";
import { CHECK_ICON, COPY_ICON } from "./icons.js";

const t = getDict();

/** 点击后对勾替换复制图标的时长。 */
const FEEDBACK_MS = 1200;

/**
 * 纯图标复制按钮。文本在点击时读取，流式中的气泡复制的是此刻持有的内容
 * 而非构建时的。
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
  // 纯图标：名称保存在 tooltip 与 aria-label 里供读屏。
  element.title = label;
  element.setAttribute("aria-label", label);
  return element;
}
