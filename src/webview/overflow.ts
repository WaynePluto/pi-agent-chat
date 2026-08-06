import { el } from "./dom.js";

/**
 * Toolbar overflow: when a button row no longer fits the panel width, its
 * secondary buttons move into a "..." popup instead of wrapping onto a second
 * line or being clipped.
 *
 * The buttons themselves are moved, not copied, so their listeners, `disabled`
 * state and `hidden` class keep working unchanged in either place. Each item
 * leaves a hidden slot behind, which is how it finds its way back.
 *
 * Fit is measured, not guessed with a breakpoint: the same row is much wider in
 * English than in Chinese, so any hard-coded `max-width` media query would
 * collapse too early in one language and too late in the other.
 */

export interface OverflowGroup {
  /** Re-measure and collapse/expand accordingly. Cheap and idempotent. */
  update(): void;
  /** Close the popup, e.g. when navigating away. */
  close(): void;
}

export interface OverflowGroupOptions {
  /** The flex row that must stay on one line. */
  row: HTMLElement;
  /** Buttons to move out, in display order. */
  items: HTMLElement[];
  /** The "..." button; already placed inside `row` by the caller. */
  toggle: HTMLButtonElement;
  /** Empty popup container; positioned by CSS relative to `row`. */
  menu: HTMLElement;
  /**
   * Width the row may occupy on one line.
   *
   * The row's own width is not usable for this: as a flex item it grows and
   * shrinks with its content, and it is the surrounding layout (the header's
   * title, the composer's padding) that decides what is actually free.
   */
  available: () => number;
}

export function createOverflowGroup({ row, items, toggle, menu, available }: OverflowGroupOptions): OverflowGroup {
  // A placeholder per item marks where it belongs when the row is wide again.
  const slots = items.map((item) => {
    const slot = el("span", "overflow-slot");
    item.before(slot);
    return slot;
  });
  let collapsed = false;

  const expand = (): void => {
    if (!collapsed) return;
    items.forEach((item, index) => slots[index]!.after(item));
    collapsed = false;
  };

  const collapse = (): void => {
    if (collapsed) return;
    for (const item of items) menu.appendChild(item);
    collapsed = true;
  };

  const close = (): void => {
    menu.classList.add("hidden");
    toggle.setAttribute("aria-expanded", "false");
  };

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = menu.classList.toggle("hidden") === false;
    toggle.setAttribute("aria-expanded", String(open));
  });
  // Any choice inside the popup completes the interaction.
  menu.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("button")) close();
  });
  document.addEventListener("click", (event) => {
    if (!menu.classList.contains("hidden") && !menu.contains(event.target as Node)) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  return {
    update(): void {
      // Hidden panels report zero size; measuring them would collapse the row
      // for no reason and the result would be wrong anyway.
      if (row.offsetParent === null) return;
      // Always measure the expanded row, so the outcome depends only on the
      // available width and growing/shrinking cannot oscillate. The row may
      // overflow for the duration of this function; it is corrected before the
      // frame is painted.
      expand();
      toggle.classList.add("hidden");
      if (neededWidth(row) <= available()) {
        close();
        return;
      }
      collapse();
      toggle.classList.remove("hidden");
    },
    close,
  };
}

/**
 * Width the row's contents want on a single line.
 *
 * Items are summed individually rather than read off the row, because the row
 * is told to shrink by its parent while the items are not (`flex: 0 0 auto`),
 * so only the items report their true size. Hidden items (`steer`/`follow-up`
 * outside a run) contribute nothing, which is exactly right: they are not
 * competing for space.
 */
function neededWidth(row: HTMLElement): number {
  const style = getComputedStyle(row);
  const gap = parseFloat(style.columnGap) || 0;
  let total = 0;
  let counted = 0;
  for (const child of row.children) {
    const element = child as HTMLElement;
    // Skip what is not laid out in the row: hidden items, the popup (absolute)
    // and the flexible spacer, whose width is whatever is left over.
    if (element.offsetParent === null) continue;
    const childStyle = getComputedStyle(element);
    if (childStyle.position === "absolute" || parseFloat(childStyle.flexGrow) > 0) continue;
    total += element.offsetWidth;
    counted += 1;
  }
  return total + Math.max(0, counted - 1) * gap;
}
