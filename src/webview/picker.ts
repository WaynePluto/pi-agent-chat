import type { ModelCatalog } from "../shared/protocol.js";
import { button, el, icon } from "./dom.js";
import { post } from "./host.js";
import { getDict } from "./i18n.js";
import { CHECK_ICON } from "./icons.js";
import { composerActionsEl, inputEl, modelBtn, pickerEl, thinkingBtn } from "./shell.js";
import { state } from "./store.js";

/**
 * The composer's quick menus for model and thinking level.
 *
 * Both are small popups anchored to the chip that opens them, in the spirit of
 * the editor's own chat controls: a native QuickPick opens centered at the top
 * of the window, far from the control the user just clicked.
 *
 * The model menu is deliberately a *switcher*, not a browser: it lists the
 * frequently used models with their provider and hands everything else —
 * search, capabilities, ⭐ frequently used, 📌 default — to the native picker
 * behind its "other models" row.
 */

const t = getDict();

type PickerKind = "model" | "thinking";

/** One rendered, selectable row and what pressing Enter on it does. */
interface PickerRow {
  element: HTMLElement;
  accept(): void;
}

let openKind: PickerKind | undefined;
/** Last catalogue pushed by the host; kept so re-opening is instant. */
let catalog: ModelCatalog | undefined;
let listEl: HTMLElement | undefined;
/** Footer row of the model menu; built once per open, never per render. */
let moreBtn: HTMLButtonElement | undefined;
let rows: PickerRow[] = [];
let selectedIndex = 0;

export function closePicker(): void {
  if (!openKind) return;
  // Typing should continue where it left off, not in a dismissed popup.
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

/** Chip click and the host's `/model` command both land here. */
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
  // The list is refreshed on every open: models in scope can change from the
  // settings menu, the native picker or the terminal in between.
  if (kind === "model") post({ type: "listModels" });
  // Focus decides who owns the arrow keys and Enter: as long as it is inside
  // the popup, the composer's own key handling stays out of the way.
  pickerEl.focus();
}

/** Host push: refresh the list in place, keeping the selection. */
export function setModelCatalog(next: ModelCatalog): void {
  catalog = next;
  if (openKind === "model") renderRows();
}

/** State changes (model switched, levels of a new model) must not leave a stale list. */
export function refreshPicker(): void {
  if (openKind) renderRows();
}

/* ---------------------------------------------------------------- */
/* Frame and placement                                               */
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
  // Everything the model menu leaves out lives one click away. The row belongs
  // to the frame, not to the list, so re-rendering rows cannot duplicate it.
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
 * Line the popup up with its chip instead of stretching it across the
 * composer, pulling it back inside when the chip sits too far right. Both the
 * chip and the popup are laid out by the composer's action row, so its own
 * coordinates are all that is needed.
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
  // Optional call: jsdom, which runs the DOM snapshot test, has no scrollIntoView.
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

/** Shared single-select row: check mark, name, muted trailing note. */
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
/* Rows                                                              */
/* ---------------------------------------------------------------- */

function buildModelRows(): PickerRow[] {
  const list = listEl!;
  list.replaceChildren();
  const built: PickerRow[] = [];

  // No frequently used models configured: say so rather than dumping the whole
  // catalogue into a popup that is not built to browse it.
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
  // No "default" marker here on purpose: since SDK 0.84.3 the session's
  // setThinkingLevel() is session-only (the global default changes only
  // through the settings menu), and the host sends just the session's current
  // level — the picker has no global default to mark.
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
/* Dismissal and keyboard                                            */
/* ---------------------------------------------------------------- */

// Clicks on the chips are ignored here: their own handler toggles the popup,
// and closing it from both places would make the second click a no-op.
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
  // List navigation belongs to whoever has focus; while the caret is back in
  // the composer, Enter must still send the message.
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
