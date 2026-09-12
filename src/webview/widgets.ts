import type { ExtensionWidget } from "../shared/protocol.js";
import { createCollapsible, type CollapsibleClasses } from "./collapsible.js";
import { el } from "./dom.js";
import { scrollToEnd } from "./transcript/scroll.js";
import { widgetsAboveEl, widgetsBelowEl } from "./shell.js";

/**
 * 扩展 widget：pi 扩展经 `ctx.ui.setWidget(key, lines)` 发布的纯文本块。
 * 这是通用 SDK 界面而非对某个扩展的支持——侧栏不解释 `key` 与行内容，
 * 只把它们放到 CLI 会放的位置：`aboveEditor` 在 transcript 与 composer
 * 之间，`belowEditor` 在 composer 与状态行之间。
 * 每块可折叠且默认展开：widget 是给人看的，但长块不能把 transcript 挤到
 * 无处可退；折叠状态按扩展自己的 key 记忆，重渲染（宿主每次发全集）后
 * 仍然有效。
 */

const WIDGET_CLASSES: CollapsibleClasses = {
  header: "widget-header",
  label: "widget-label",
  status: "widget-status",
  chevron: "widget-chevron",
  body: "widget-body",
};

/** 用户折叠过的 key；不在集合里的都展开渲染。 */
const collapsed = new Set<string>();
/** 最近一次全集；切换折叠时据此重绘两个容器。 */
let lastItems: ExtensionWidget[] = [];

export function renderExtensionWidgets(items: ExtensionWidget[]): void {
  lastItems = items;
  paint(widgetsAboveEl, items.filter((item) => item.placement !== "belowEditor"));
  paint(widgetsBelowEl, items.filter((item) => item.placement === "belowEditor"));
  // widget 区在 transcript 与 composer 之间，出现/消失/折叠都会压缩
  // transcript 视口；宿主在 history 之后才发这批数据，进入会话时的贴底
  // 需要在这里补一次（仅跟随态生效）。
  scrollToEnd();
}

function paint(container: HTMLElement, items: ExtensionWidget[]): void {
  container.replaceChildren();
  container.classList.toggle("hidden", items.length === 0);
  for (const item of items) {
    const block = createCollapsible({
      classes: WIDGET_CLASSES,
      rootClass: "widget",
      label: item.key,
      // 折叠的 widget 仍标注它藏了多少行。
      status: collapsed.has(item.key) ? String(item.lines.length) : "",
      expanded: !collapsed.has(item.key),
      parent: container,
      onToggle: (expanded) => {
        if (expanded) collapsed.delete(item.key);
        else collapsed.add(item.key);
        renderExtensionWidgets(lastItems);
      },
    });
    // 立即填充：body 就几行且默认可见，懒渲染只会多出一条状态过期路径。
    for (const line of item.lines) block.body.appendChild(el("div", "widget-line", line));
  }
}
