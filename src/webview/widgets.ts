import type { ExtensionWidget } from "../shared/protocol.js";
import { createCollapsible, type CollapsibleClasses } from "./collapsible.js";
import { el } from "./dom.js";
import { widgetsAboveEl, widgetsBelowEl } from "./shell.js";

/**
 * Extension widgets: the plain-text blocks a pi extension publishes through
 * `ctx.ui.setWidget(key, lines)`.
 *
 * This is generic SDK surface, not support for any particular extension — the
 * sidebar never interprets `key` or the lines, it only places them where the
 * CLI would. `aboveEditor` lands between the transcript and the composer,
 * `belowEditor` between the composer and the status line, which is the same
 * spatial relationship the terminal UI gives them.
 *
 * Each block is collapsible and starts expanded: a widget is meant to be seen,
 * but a long one must not be able to squeeze the transcript with no way out.
 * Collapse state is keyed by the extension's own key so it survives re-renders,
 * which arrive on every republish (the host always sends the full set).
 */

const WIDGET_CLASSES: CollapsibleClasses = {
  header: "widget-header",
  label: "widget-label",
  status: "widget-status",
  chevron: "widget-chevron",
  body: "widget-body",
};

/** Keys the user collapsed; everything absent renders expanded. */
const collapsed = new Set<string>();
/** Last full set, so a collapse toggle can repaint both containers. */
let lastItems: ExtensionWidget[] = [];

export function renderExtensionWidgets(items: ExtensionWidget[]): void {
  lastItems = items;
  paint(widgetsAboveEl, items.filter((item) => item.placement !== "belowEditor"));
  paint(widgetsBelowEl, items.filter((item) => item.placement === "belowEditor"));
}

function paint(container: HTMLElement, items: ExtensionWidget[]): void {
  container.replaceChildren();
  container.classList.toggle("hidden", items.length === 0);
  for (const item of items) {
    const block = createCollapsible({
      classes: WIDGET_CLASSES,
      rootClass: "widget",
      label: item.key,
      // Collapsed widgets still say how much they are hiding.
      status: collapsed.has(item.key) ? String(item.lines.length) : "",
      expanded: !collapsed.has(item.key),
      parent: container,
      onToggle: (expanded) => {
        if (expanded) collapsed.delete(item.key);
        else collapsed.add(item.key);
        renderExtensionWidgets(lastItems);
      },
    });
    // Eagerly filled: the body is a handful of lines and is visible by default,
    // so lazy rendering would only add a stale-state path.
    for (const line of item.lines) block.body.appendChild(el("div", "widget-line", line));
  }
}
