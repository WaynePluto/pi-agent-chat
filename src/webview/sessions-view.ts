import type { SessionListItem } from "../shared/protocol.js";
import { formatLocalTimestamp } from "../shared/time.js";
import { button, el } from "./dom.js";
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
  const row = el(
    "div",
    `session-row${item.current ? " current" : ""}${item.claimedElsewhere ? ` claimed-${item.claimedElsewhere}` : ""}${item.delegationRole ? ` delegation-${item.delegationRole}` : ""}`,
  );
  row.title = item.file;

  const main = button("session-main", undefined, () => onRowClick(item));
  main.title = claimTitle(item) ?? t.sessionResumeTitle;
  const titleRow = el("span", "session-title");
  const badge = statusBadge(item);
  if (badge) titleRow.appendChild(badge);
  titleRow.appendChild(el("span", "session-title-text", truncate(item.title, MAX_SESSION_TITLE_CHARS)));
  main.append(
    titleRow,
    el("span", "session-meta", formatLocalTimestamp(item.timestamp)),
  );
  row.appendChild(main);

  // Action buttons occupy fixed slots on every row; unavailable actions are
  // disabled rather than hidden. Status badges live inline before the title.
  row.appendChild(renameButton(item));
  row.appendChild(deleteButton(item));
  return row;
}

function onRowClick(item: SessionListItem): void {
  if (item.claimedElsewhere) {
    // A session belongs to its controller, not to either GUI. Move that exact
    // controller here; the host replaces a visible source with an empty session.
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
    badge.textContent = t.sessionOpenElsewhere;
  } else if (item.claimedElsewhere === "background") {
    badge.append(spinner(), document.createTextNode(` ${t.sessionRunningInBackground}`));
  } else if (item.delegationRole === "child") {
    badge.append(spinner(), document.createTextNode(` ${t.sessionSubagentRunning}`));
  } else if (item.delegationRole === "parent") {
    badge.textContent = t.sessionParentWaiting;
  } else if (item.running) {
    // Same braille spinner as the bottom "Working..." indicator.
    badge.append(spinner(), document.createTextNode(` ${t.sessionRunning}`));
  } else if (item.current && state.preview) {
    badge.textContent = t.sessionPreviewing;
  } else {
    return undefined;
  }
  return badge;
}

function deleteButton(item: SessionListItem): HTMLElement {
  const del = button("session-delete", t.sessionDelete, (event) => {
    event.stopPropagation();
    post({ type: "deleteSession", file: item.file });
  });
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

function renameButton(item: SessionListItem): HTMLElement {
  const rename = button("session-rename", t.sessionRename, (event) => {
    event.stopPropagation();
    post({ type: "renameSession", file: item.file });
  });
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
