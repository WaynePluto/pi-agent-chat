import { button, el, icon } from "./dom.js";
import { CHEVRON_ICON } from "./icons.js";
import { getDict } from "./i18n.js";

/**
 * The one collapsible "header + lazy body" widget used by the transcript cards,
 * the work block, the resource panel and its sections.
 *
 * These four used to be hand-rolled separately and had already drifted apart
 * (only the work block exposed `aria-expanded`, only the cards rendered their
 * body lazily). The class names still differ per context — they carry genuinely
 * different styling — so they are passed in rather than hard-coded, which also
 * documents all four naming schemes in one place.
 */

const t = getDict();

export interface CollapsibleClasses {
  header: string;
  label: string;
  status: string;
  chevron: string;
  body: string;
  /** Activity dot; omitted where the context has no running state. */
  pulse?: string;
}

export const CARD_CLASSES: CollapsibleClasses = {
  header: "card-header",
  label: "card-label",
  status: "card-status",
  pulse: "card-pulse",
  chevron: "card-chevron",
  body: "card-body",
};

export const WORK_CLASSES: CollapsibleClasses = {
  header: "work-header",
  label: "work-label",
  status: "work-status",
  pulse: "work-pulse",
  chevron: "work-chevron",
  body: "work-body",
};

export const RESOURCES_CLASSES: CollapsibleClasses = {
  header: "resources-toggle",
  label: "resources-title",
  status: "resources-counts",
  chevron: "resources-chevron",
  body: "resources-body",
};

export const RESOURCE_SECTION_CLASSES: CollapsibleClasses = {
  header: "resource-header",
  label: "resource-name",
  status: "resource-summary",
  chevron: "resource-chevron",
  body: "resource-details",
};

export interface CollapsibleOptions {
  classes: CollapsibleClasses;
  /** Class of the outer element, e.g. `tool-card` or `work-block running`. */
  rootClass: string;
  tag?: "div" | "section";
  label: string;
  status?: string;
  expanded?: boolean;
  /** Attachment point; a detached fragment during history replay. */
  parent?: HTMLElement | DocumentFragment;
  /** Builds the body on first expansion; omit for eagerly filled bodies. */
  render?: (body: HTMLElement) => void;
  onToggle?: (expanded: boolean) => void;
}

export interface Collapsible {
  readonly root: HTMLElement;
  readonly labelEl: HTMLElement;
  readonly statusEl: HTMLElement;
  readonly body: HTMLElement;
  readonly expanded: boolean;
  setExpanded(expanded: boolean): void;
  /** Mark the rendered body stale without rebuilding it yet. */
  invalidate(): void;
  /** Rebuild the body if it is stale and currently visible. */
  refresh(): void;
}

export function createCollapsible(options: CollapsibleOptions): Collapsible {
  const { classes } = options;
  const root = el(options.tag ?? "div", options.rootClass);
  const labelEl = el("span", classes.label, options.label);
  const statusEl = el("span", classes.status, options.status ?? "");
  const chevron = icon(CHEVRON_ICON, classes.chevron);
  const body = el("div", classes.body);

  const header = button(classes.header);
  header.append(labelEl, statusEl, ...(classes.pulse ? [el("span", classes.pulse)] : []), chevron);

  let expanded = options.expanded ?? false;
  let rendered = false;

  const renderBody = () => {
    if (rendered || !options.render) return;
    options.render(body);
    rendered = true;
  };

  const apply = () => {
    root.classList.toggle("collapsed", !expanded);
    header.setAttribute("aria-expanded", String(expanded));
    header.title = expanded ? t.collapse : t.expand;
    if (expanded) renderBody();
  };

  const collapsible: Collapsible = {
    root,
    labelEl,
    statusEl,
    body,
    get expanded() {
      return expanded;
    },
    setExpanded(next: boolean) {
      expanded = next;
      apply();
    },
    invalidate() {
      rendered = false;
    },
    refresh() {
      if (expanded) renderBody();
    },
  };

  header.addEventListener("click", () => {
    collapsible.setExpanded(!expanded);
    options.onToggle?.(expanded);
  });

  apply();
  root.append(header, body);
  options.parent?.appendChild(root);
  return collapsible;
}
