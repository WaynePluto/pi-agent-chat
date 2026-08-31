import type { SessionListItem } from "../shared/protocol.js";
import { formatLocalTimestamp } from "../shared/time.js";
import { button, el, icon } from "./dom.js";
import { RENAME_ICON, OPEN_IN_EDITOR_ICON, NEW_WINDOW_ICON, TRASH_ICON } from "./icons.js";
import { MAX_SESSION_TITLE_CHARS, truncate } from "./format.js";
import { post } from "./host.js";
import { getDict } from "./i18n.js";
import { sessionsEl } from "./shell.js";
import { spinner } from "./spinner.js";
import { state } from "./store.js";
import { showLoading } from "./transcript.js";

/**
 * The sessions list: a full-height page on narrow surfaces and a persistent
 * left rail in wide mode.
 *
 * Showing/hiding it is a layout decision owned by `main.ts`; this module only
 * renders the list and reports what the user picked.
 */

const t = getDict();

/** Rows rendered per batch; more are appended as the list scrolls near the bottom. */
const PAGE_SIZE = 20;
/** Distance from the bottom (px) at which the next batch is appended. */
const SCROLL_THRESHOLD = 200;

interface SessionsHooks {
  /** Leave the sessions page (layout lives in main.ts). */
  close(): void;
  /** Called before switching sessions, to drop composer state. */
  onResume(): void;
}

let hooks: SessionsHooks = { close: () => {}, onResume: () => {} };

/** Latest list from the host; search filters this in memory, no rescans. */
let allItems: SessionListItem[] = [];
let searchQuery = "";
/** How many filtered rows are currently in the DOM. */
let renderedCount = 0;
let listEl: HTMLElement | undefined;
let searchInputEl: HTMLInputElement | undefined;

export function initSessions(sessionsHooks: SessionsHooks): void {
  hooks = sessionsHooks;
}

export function isSessionsVisible(): boolean {
  return !sessionsEl.classList.contains("hidden");
}

/** Toggle the page/rail and render the latest cached listing when it appears. */
export function setSessionsVisible(visible: boolean): void {
  const changed = visible === sessionsEl.classList.contains("hidden");
  sessionsEl.classList.toggle("hidden", !visible);
  if (visible && changed) renderSessions(allItems);
}

export function renderSessions(items: SessionListItem[]): void {
  allItems = items;
  if (!isSessionsVisible()) return;
  // Rebuilding must preserve both search editing and the reading position of
  // the independently scrolling list during live cross-surface refreshes.
  const focusSearch = document.activeElement === searchInputEl;
  const caret = searchInputEl?.selectionStart ?? searchQuery.length;
  const scrollTop = listEl?.scrollTop ?? 0;
  const rowBudget = Math.max(PAGE_SIZE, renderedCount);
  sessionsEl.replaceChildren();
  const content = el("div", "sessions-content content-column");
  sessionsEl.appendChild(content);

  const header = el("div", "sessions-header");
  header.append(el("span", undefined, t.sessionsHeader));
  content.appendChild(header);

  searchInputEl = document.createElement("input");
  searchInputEl.type = "text";
  searchInputEl.className = "sessions-search";
  searchInputEl.placeholder = t.sessionsSearchPlaceholder;
  searchInputEl.value = searchQuery;
  searchInputEl.addEventListener("input", () => {
    searchQuery = searchInputEl?.value ?? "";
    if (listEl) listEl.scrollTop = 0;
    renderList();
  });
  content.appendChild(searchInputEl);

  listEl = el("div", "sessions-list");
  listEl.addEventListener("scroll", () => {
    if (listEl && listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - SCROLL_THRESHOLD) renderMore();
  });
  content.appendChild(listEl);
  renderList(rowBudget);
  listEl.scrollTop = scrollTop;
  if (focusSearch && searchInputEl) {
    searchInputEl.focus();
    searchInputEl.setSelectionRange(caret, caret);
  }
}

function filteredItems(): SessionListItem[] {
  const query = searchQuery.trim().toLowerCase();
  if (!query) return allItems;
  return allItems.filter((item) => item.title.toLowerCase().includes(query));
}

/** (Re)fill the list container, normally with the first filtered batch. */
function renderList(upTo = PAGE_SIZE): void {
  if (!listEl) return;
  listEl.replaceChildren();
  renderedCount = 0;
  const items = filteredItems();
  if (items.length === 0) {
    listEl.appendChild(el("div", "sessions-empty", allItems.length === 0 ? t.sessionsEmpty : t.sessionsNoMatch));
    return;
  }
  appendRows(items, upTo);
}

/** Append the next batch when the page scrolls near the bottom. */
function renderMore(): void {
  if (!listEl || !isSessionsVisible()) return;
  const items = filteredItems();
  if (renderedCount >= items.length) return;
  appendRows(items, renderedCount + PAGE_SIZE);
}

function appendRows(items: SessionListItem[], upTo: number): void {
  if (!listEl) return;
  const end = Math.min(upTo, items.length);
  for (let i = renderedCount; i < end; i++) listEl.appendChild(sessionRow(items[i]!));
  renderedCount = end;
}

function sessionRow(item: SessionListItem): HTMLElement {
  // `running` drives the 2px status bar, which reports activity only — being
  // the current session is said by the selected background instead. A session
  // claimed by a background controller is running too, just not here.
  const running = item.running || item.claimedElsewhere === "background";
  const row = el(
    "div",
    `session-row${item.current ? " current" : ""}${running ? " running" : ""}${item.claimedElsewhere ? ` claimed-${item.claimedElsewhere}` : ""}${item.delegationRole ? ` delegation-${item.delegationRole}` : ""}`,
  );
  row.title = item.file;

  const main = button("session-main", undefined, () => onRowClick(item));
  main.title = claimTitle(item) ?? t.sessionResumeTitle;
  const titleRow = el("span", "session-title");
  titleRow.appendChild(el("span", "session-title-text", truncate(item.title, MAX_SESSION_TITLE_CHARS)));
  // The badge leads the meta row rather than the title row. Inline before the
  // title it indents that title by its own width, so a list where only some
  // sessions are running gets a ragged left edge -- and the titles are what
  // the eye scans down. On the meta row it leads a line that is already
  // secondary, and every title starts at the same x.
  const metaRow = el("span", "session-meta");
  const badge = statusBadge(item);
  if (badge) metaRow.appendChild(badge);
  metaRow.appendChild(el("span", "session-time", formatLocalTimestamp(item.timestamp)));
  main.append(titleRow, metaRow);
  row.appendChild(main);

  // Action buttons occupy fixed slots on every row; unavailable actions are
  // disabled rather than hidden.
  const actions = el("div", "session-actions");
  actions.appendChild(renameButton(item));
  actions.appendChild(openInEditorButton(item));
  actions.appendChild(openInNewWindowButton(item));
  actions.appendChild(deleteButton(item));
  row.appendChild(actions);
  return row;
}

function onRowClick(item: SessionListItem): void {
  if (item.claimedElsewhere) {
    // A session belongs to its controller, not to either GUI. Move that exact
    // controller here; the host replaces a visible source with an empty session.
    // A lane row addresses the controller that runs it, and the host lands on
    // that lane once it has moved.
    post({ type: "revealSession", file: item.file });
    hooks.close();
    return;
  }
  if (item.delegationRole === "parent") {
    post({ type: "showLane" });
    hooks.close();
    return;
  }
  if (item.delegationRole === "child") {
    // Address the lane by id when the run still knows it, so it opens as a
    // subagent rather than as an unrelated read-only session.
    const lane = state.delegation?.lanes.find((entry) => entry.sessionFile === item.file);
    post({ type: "showLane", laneId: lane?.id, sessionFile: item.file });
    hooks.close();
    return;
  }
  if (!item.current) {
    hooks.onResume();
    // Loading a large session file takes the host a moment; without this the
    // previous transcript would stay on screen and read as a frozen UI. If the
    // current controller is busy, the host leaves it running in the background
    // and gives this surface a controller for the selected session.
    showLoading();
    post({ type: "resumeSession", file: item.file });
  }
  hooks.close();
}

function statusBadge(item: SessionListItem): HTMLElement | undefined {
  const badge = el("span", "session-badge");
  if (item.claimedElsewhere === "visible") {
    // Neutral on purpose: this describes *this window's* claim, not a state of
    // the session, so it must not read as "running" (see `_sessions.scss`).
    badge.textContent = t.sessionOpenElsewhere;
  } else if (item.delegationRole === "child") {
    // Ahead of "running in the background": both are true of a task line whose
    // parent has moved off-screen, and this one says what it is doing. The
    // click still routes by the claim, so nothing is lost by naming the role.
    badge.classList.add("subagent");
    badge.append(spinner(), document.createTextNode(t.sessionSubagentRunning));
  } else if (item.delegationRole === "parent") {
    badge.classList.add("subagent");
    badge.textContent = t.sessionParentWaiting;
  } else if (item.claimedElsewhere === "background") {
    badge.classList.add("running");
    badge.append(spinner(), document.createTextNode(t.sessionRunningInBackground));
  } else if (item.running) {
    badge.classList.add("running");
    // Same braille spinner as the bottom "Working..." indicator. No separating
    // space in the text: the badge is a flex row and its `gap` sets the
    // distance, so a literal space would double it.
    badge.append(spinner(), document.createTextNode(t.sessionRunning));
  } else if (item.current && state.preview) {
    badge.textContent = t.sessionPreviewing;
  } else {
    return undefined;
  }
  return badge;
}

function deleteButton(item: SessionListItem): HTMLElement {
  const del = button("session-action session-delete", undefined, (event) => {
    event.stopPropagation();
    post({ type: "deleteSession", file: item.file });
  });
  del.appendChild(icon(TRASH_ICON));
  if (item.current || item.running || item.delegationRole || item.claimedElsewhere) {
    del.disabled = true;
    del.title = claimTitle(item) ?? t.sessionDeleteCurrentTitle;
  } else {
    del.title = t.sessionDeleteTitle;
  }
  return del;
}

function claimTitle(item: SessionListItem): string | undefined {
  if (item.claimedElsewhere === "visible") return t.sessionOpenElsewhereTitle;
  if (item.claimedElsewhere === "background") return t.sessionBackgroundTitle;
  return undefined;
}

function openInEditorButton(item: SessionListItem): HTMLElement {
  const btn = button("session-action session-open-editor", undefined, (event) => {
    event.stopPropagation();
    post({ type: "openSessionInEditor", file: item.file });
    hooks.close();
  });
  btn.appendChild(icon(OPEN_IN_EDITOR_ICON));
  btn.title = t.sessionOpenInEditorTitle;
  return btn;
}

function openInNewWindowButton(item: SessionListItem): HTMLElement {
  const btn = button("session-action session-open-window", undefined, (event) => {
    event.stopPropagation();
    post({ type: "openSessionInNewWindow", file: item.file });
    hooks.close();
  });
  btn.appendChild(icon(NEW_WINDOW_ICON));
  btn.title = t.sessionOpenInNewWindowTitle;
  return btn;
}

function renameButton(item: SessionListItem): HTMLElement {
  const rename = button("session-action session-rename", undefined, (event) => {
    event.stopPropagation();
    post({ type: "renameSession", file: item.file });
  });
  rename.appendChild(icon(RENAME_ICON));
  // A running subagent appends to its session file, so renaming it must wait
  // for the run to finish. Sessions claimed by another surface can still be
  // renamed — the rename just appends metadata, it does not interfere.
  if (item.delegationRole === "child") {
    rename.disabled = true;
    rename.title = t.sessionRenameRunningTitle;
  } else {
    rename.title = t.sessionRenameTitle;
  }
  return rename;
}
