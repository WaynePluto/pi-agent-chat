import { el } from "./dom.js";

/**
 * 工具栏溢出：按钮行放不下时，次要按钮收进「...」弹层，而不是换行到第
 * 二行或被裁掉。按钮是移动而非复制，监听器、`disabled` 状态与 `hidden`
 * class 在两个位置都照常工作；每个条目留下一个隐藏占位，收回时靠它找到
 * 回程。合不合适靠测量而不是断点：同一行英文比中文宽得多，硬编码的
 * `max-width` 媒体查询会在一种语言里收得太早、另一种里收得太晚。
 */

export interface OverflowGroup {
  /** 重新测量并相应收拢 / 展开。开销小且幂等。 */
  update(): void;
  /** 关闭弹层，例如离开页面时。 */
  close(): void;
}

export interface OverflowGroupOptions {
  /** 必须保持单行的 flex 行。 */
  row: HTMLElement;
  /** 待移出的按钮，按显示顺序。 */
  items: HTMLElement[];
  /** 「...」按钮；调用方已把它放进 `row`。 */
  toggle: HTMLButtonElement;
  /** 空的弹层容器；由 CSS 相对 `row` 定位。 */
  menu: HTMLElement;
  /**
   * 该行单行可占用的宽度。
   *
   * 行自身的宽度不可用：它是 flex item，随内容伸缩，真正决定可用空间的
   * 是外层布局（header 的标题、composer 的内边距）。
   */
  available: () => number;
}

export function createOverflowGroup({ row, items, toggle, menu, available }: OverflowGroupOptions): OverflowGroup {
  // 每个条目一个占位符，标记行恢复宽度时它的归属位置。
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
  // 弹层内的任何选择都终结这次交互。
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
      // 隐藏的面板测得 0 尺寸；此时测量只会无端收拢该行，结果也不对。
      if (row.offsetParent === null) return;
      // 总是对展开态测量，结果只取决于可用宽度，放大 / 收拢不会振荡。函数
      // 执行期间行可能溢出，但会在本帧绘制前纠正。
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
 * 行内内容单行排开想要的宽度。
 *
 * 逐项求和而不是读整行：父布局要求行收缩而行内条目不受缩（`flex: 0 0
 * auto`），只有条目报得出真实尺寸。隐藏条目（非运行中的 steer/follow-up）
 * 计 0，恰如其分——它们本来就不参与抢空间。
 */
function neededWidth(row: HTMLElement): number {
  const style = getComputedStyle(row);
  const gap = parseFloat(style.columnGap) || 0;
  let total = 0;
  let counted = 0;
  for (const child of row.children) {
    const element = child as HTMLElement;
    // 跳过不参与行内布局的：隐藏条目、弹层（绝对定位）与弹性 spacer
    // ——它的宽度是剩下的部分。
    if (element.offsetParent === null) continue;
    const childStyle = getComputedStyle(element);
    if (childStyle.position === "absolute" || parseFloat(childStyle.flexGrow) > 0) continue;
    total += element.offsetWidth;
    counted += 1;
  }
  return total + Math.max(0, counted - 1) * gap;
}
