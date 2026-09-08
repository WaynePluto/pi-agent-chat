import type { ModelCatalog } from "../shared/protocol.js";
import { button, el, icon } from "./dom.js";
import { post } from "./host.js";
import { getDict } from "./i18n.js";
import { CHECK_ICON } from "./icons.js";
import { composerActionsEl, inputEl, modelBtn, pickerEl, thinkingBtn } from "./shell.js";
import { state } from "./store.js";

/**
 * composer 的模型与思考等级快捷菜单。两者都是锚定在触发 chip 上的小弹层，
 * 对齐编辑器自己的聊天控件——原生 QuickPick 固定出现在窗口顶部，离用户
 * 刚点的控件太远。模型菜单刻意只做切换器而非浏览器：列出常用模型及供应
 * 商，其余一切（搜索、能力详情、⭐常用、📌默认）交给「其他模型」行后面
 * 的原生 picker。
 */

const t = getDict();

type PickerKind = "model" | "thinking";

/** 一条已渲染的可选行，及在其上按 Enter 的动作。 */
interface PickerRow {
  element: HTMLElement;
  accept(): void;
}

let openKind: PickerKind | undefined;
/** 宿主最近推送的目录；留存以便再次打开即时显示。 */
let catalog: ModelCatalog | undefined;
let listEl: HTMLElement | undefined;
/** 模型菜单的底部行；每次打开建一次，不随每次渲染重建。 */
let moreBtn: HTMLButtonElement | undefined;
let rows: PickerRow[] = [];
let selectedIndex = 0;

export function closePicker(): void {
  if (!openKind) return;
  // 输入应回到关闭前的位置继续，而不是停在已关的弹层里。
  const hadFocus = pickerEl.contains(document.activeElement);
  openKind = undefined;
  listEl = undefined;
  moreBtn = undefined;
  rows = [];
  selectedIndex = 0;
  pickerEl.replaceChildren();
  pickerEl.classList.add("hidden");
  if (hadFocus && !inputEl.disabled) inputEl.focus();
}

/** 点击 chip 与宿主的 `/model` 命令都走这里。 */
export function togglePicker(kind: PickerKind): void {
  if (openKind === kind) {
    closePicker();
    return;
  }
  openPicker(kind);
}

export function openPicker(kind: PickerKind): void {
  const anchor = anchorFor(kind);
  if (anchor.disabled) return;
  openKind = kind;
  pickerEl.classList.remove("hidden");
  buildFrame(kind);
  renderRows();
  anchorTo(anchor);
  // 每次打开都刷新列表：两次打开之间，设置菜单、原生 picker 或终端都
  // 可能改了常用模型。
  if (kind === "model") post({ type: "listModels" });
  // 焦点决定方向键与 Enter 归谁：只要焦点在弹层内，composer 自己的按键
  // 处理就让路。
  pickerEl.focus();
}

/** 宿主推送：就地刷新列表，保留选中项。 */
export function setModelCatalog(next: ModelCatalog): void {
  catalog = next;
  if (openKind === "model") renderRows();
}

/** 状态变化（切换模型、新模型的等级列表）不能留下过期列表。 */
export function refreshPicker(): void {
  if (openKind) renderRows();
}

/* ---------------------------------------------------------------- */
/* 框架与定位 */
/* ---------------------------------------------------------------- */

function anchorFor(kind: PickerKind): HTMLButtonElement {
  return kind === "model" ? modelBtn : thinkingBtn;
}

function buildFrame(kind: PickerKind): void {
  pickerEl.replaceChildren();
  pickerEl.appendChild(el("div", "picker-title", pickerTitle(kind)));
  moreBtn = undefined;
  listEl = el("div", "picker-list");
  listEl.setAttribute("role", "listbox");
  pickerEl.appendChild(listEl);
  // 模型菜单装不下的都在一次点击之外。该行属于框架而非列表，重渲染行
  // 不会复制它。
  if (kind === "model") {
    moreBtn = button("picker-more", t.modelPickerOther, () => {
      closePicker();
      post({ type: "pickModel" });
    });
    pickerEl.appendChild(moreBtn);
  }
}

function pickerTitle(kind: PickerKind): string {
  return kind === "model" ? t.modelPickerTitle : t.thinkingPickerTitle;
}

/**
 * 让弹层与它的 chip 对齐而不是横跨整个 composer，chip 过靠右时拉回边界
 * 内。chip 与弹层都由 composer 动作行排版，用它的坐标就够了。
 */
function anchorTo(anchor: HTMLElement): void {
  const left = anchor.offsetParent === composerActionsEl ? anchor.offsetLeft : 0;
  const overflow = left + pickerEl.offsetWidth - composerActionsEl.clientWidth;
  pickerEl.style.left = `${Math.max(0, overflow > 0 ? left - overflow : left)}px`;
}

function renderRows(): void {
  if (!listEl || !openKind) return;
  rows = openKind === "model" ? buildModelRows() : buildThinkingRows();
  if (selectedIndex >= rows.length) selectedIndex = Math.max(0, rows.length - 1);
  applySelection();
  // 可选调用：跑 DOM 快照测试的 jsdom 没有 scrollIntoView。
  rows[selectedIndex]?.element.scrollIntoView?.({ block: "nearest" });
}

function applySelection(): void {
  rows.forEach((row, index) => row.element.classList.toggle("selected", index === selectedIndex));
}

function moveSelection(delta: number): void {
  if (rows.length === 0) return;
  selectedIndex = (selectedIndex + delta + rows.length) % rows.length;
  applySelection();
  rows[selectedIndex]?.element.scrollIntoView?.({ block: "nearest" });
}

/** 通用单选行：对勾、名称、弱化的尾注。 */
function buildRow(name: string, options: { note?: string; current: boolean; accept(): void }): PickerRow {
  const element = el("div", `picker-row${options.current ? " current" : ""}`);
  element.setAttribute("role", "option");
  const mark = el("span", "picker-mark");
  if (options.current) mark.appendChild(icon(CHECK_ICON));
  element.append(mark, el("span", "picker-name", name));
  if (options.note) element.appendChild(el("span", "picker-note", options.note));
  element.addEventListener("click", options.accept);
  return { element, accept: options.accept };
}

/* ---------------------------------------------------------------- */
/* 行 */
/* ---------------------------------------------------------------- */

function buildModelRows(): PickerRow[] {
  const list = listEl!;
  list.replaceChildren();
  const built: PickerRow[] = [];

  // 未配置常用模型：直说，而不是把整个目录倒进一个本就不是用来浏览的
  // 弹层。
  if (!catalog) list.appendChild(el("div", "picker-empty", t.modelPickerLoading));
  else if (catalog.items.length === 0) list.appendChild(el("div", "picker-empty", t.modelPickerNone));

  for (const item of catalog?.items ?? []) {
    const current = item.id === state.modelId && item.provider === state.providerId;
    const row = buildRow(item.id, {
      note: item.provider,
      current,
      accept: () => {
        closePicker();
        if (!current) post({ type: "setModel", provider: item.provider, modelId: item.id });
      },
    });
    row.element.title = `${item.provider}/${item.id}`;
    list.appendChild(row.element);
    built.push(row);
    if (current) selectedIndex = built.length - 1;
  }

  if (moreBtn) built.push({ element: moreBtn, accept: () => moreBtn?.click() });
  return built;
}

function buildThinkingRows(): PickerRow[] {
  const list = listEl!;
  list.replaceChildren();
  const built: PickerRow[] = [];
  // 刻意不标「默认」：SDK 0.84.3 起会话的 setThinkingLevel() 只作用于当
  // 前会话（全局默认只能经设置菜单改），宿主发来的就是会话当前等级
  // ——picker 没有可标的全局默认。
  for (const level of state.thinkingLevels ?? []) {
    const current = level === state.thinkingLevel;
    const row = buildRow(level, {
      current,
      accept: () => {
        closePicker();
        if (!current) post({ type: "setThinkingLevel", level });
      },
    });
    list.appendChild(row.element);
    built.push(row);
    if (current) selectedIndex = built.length - 1;
  }
  return built;
}

/* ---------------------------------------------------------------- */
/* 关闭与键盘 */
/* ---------------------------------------------------------------- */

// 这里忽略对 chip 的点击：chip 自己的 handler 负责开合弹层，两处都关会
// 让第二次点击落空。
document.addEventListener("click", (event) => {
  if (!openKind) return;
  const target = event.target as Node;
  if (pickerEl.contains(target) || modelBtn.contains(target) || thinkingBtn.contains(target)) return;
  closePicker();
});

document.addEventListener("keydown", (event) => {
  if (!openKind) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closePicker();
    return;
  }
  // 列表导航归焦点持有者；光标回到 composer 时，Enter 仍要能发送消息。
  if (!pickerEl.contains(document.activeElement)) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveSelection(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    rows[selectedIndex]?.accept();
  }
});
