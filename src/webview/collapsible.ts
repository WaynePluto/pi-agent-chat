import { button, el, icon } from "./dom.js";
import { CHEVRON_ICON } from "./icons.js";
import { getDict } from "./i18n.js";

/**
 * 唯一的「标题 + 懒加载体」折叠控件，供 transcript 卡片、执行过程块、
 * 资源面板及其 section 共用。
 *
 * 这四处曾各自手写、已经漂移（只有执行过程块有 `aria-expanded`、只有卡
 * 片懒渲染 body）。class 名仍随上下文不同——那是真实的样式差异——因此
 * 作为参数传入而非硬编码，顺带把四套命名集中记在一处。
 */

const t = getDict();

export interface CollapsibleClasses {
  header: string;
  label: string;
  status: string;
  chevron: string;
  body: string;
  /** 活动指示点；上下文没有运行态时省略。 */
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
  /** 外层元素的 class，如 `tool-card` 或 `work-block running`。 */
  rootClass: string;
  tag?: "div" | "section";
  label: string;
  status?: string;
  expanded?: boolean;
  /** 挂载点；历史重放期间是未挂接的 fragment。 */
  parent?: HTMLElement | DocumentFragment;
  /** 首次展开时构建 body；立即填充的 body 可省略。 */
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
  /** 把已渲染的 body 标脏，但暂不重建。 */
  invalidate(): void;
  /** body 已标脏且当前可见时重建它。 */
  refresh(): void;
}

export function createCollapsible(options: CollapsibleOptions): Collapsible {
  const { classes } = options;
  // 共享基类：折叠态的几何规则靠它拿到稳定的高优先级，压过各上下文对 body
  // 的尺寸覆写（如 compaction-boundary 的 max-height），不用 !important。
  const root = el(options.tag ?? "div", `collapsible ${options.rootClass}`);
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
