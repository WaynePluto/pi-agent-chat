import type { SessionListItem } from "../shared/protocol.js";
import { button, el } from "./dom.js";
import { MAX_SESSION_TITLE_CHARS, truncate } from "./format.js";
import { post } from "./host.js";
import { getDict } from "./i18n.js";
import { sessionsEl } from "./shell.js";
import { spinner } from "./spinner.js";
import { state } from "./store.js";
import { showLoading } from "./transcript.js";

/**
 * The sessions page: a full-height list replacing the chat while open.
 *
 * Showing/hiding the page is a layout decision owned by `main.ts`; this module
 * only renders the list and reports what the user picked.
 */

const t = getDict();

const TIMESTAMP_CHARS = 16; // "YYYY-MM-DDTHH:MM"
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
  sessionsEl.addEventListener("scroll", () => {
    if (sessionsEl.scrollTop + sessionsEl.clientHeight >= sessionsEl.scrollHeight - SCROLL_THRESHOLD) {
      renderMore();
    }
  });
}

export function isSessionsOpen(): boolean {
  return !sessionsEl.classList.contains("hidden");
}

export function renderSessions(items: SessionListItem[]): void {
  allItems = items;
  if (!isSessionsOpen()) return;
  // Rebuilding steals focus from the search box; remember the caret.
  const focusSearch = document.activeElement === searchInputEl;
  const caret = searchInputEl?.selectionStart ?? searchQuery.length;
  sessionsEl.replaceChildren();

  const header = el("div", "sessions-header");
  header.append(el("span", undefined, t.sessionsHeader));
  sessionsEl.appendChild(header);

  searchInputEl = document.createElement("input");
  searchInputEl.type = "text";
  searchInputEl.className = "sessions-search";
  searchInputEl.placeholder = t.sessionsSearchPlaceholder;
  searchInputEl.value = searchQuery;
  searchInputEl.addEventListener("input", () => {
    searchQuery = searchInputEl?.value ?? "";
    renderList();
  });
  sessionsEl.appendChild(searchInputEl);

  listEl = el("div", "sessions-list");
  sessionsEl.appendChild(listEl);
  renderList();
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

/** (Re)fill the list container with the first batch of filtered rows. */
function renderList(): void {
  if (!listEl) return;
  listEl.replaceChildren();
  renderedCount = 0;
  const items = filteredItems();
  if (items.length === 0) {
    listEl.appendChild(el("div", "sessions-empty", allItems.length === 0 ? t.sessionsEmpty : t.sessionsNoMatch));
    return;
  }
  appendRows(items, PAGE_SIZE);
}

/** Append the next batch when the page scrolls near the bottom. */
function renderMore(): void {
  if (!listEl || !isSessionsOpen()) return;
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
    `session-row${item.current ? " current" : ""}${item.delegationRole ? ` delegation-${item.delegationRole}` : ""}`,
  );
  row.title = item.file;

  const main = button("session-main", undefined, () => onRowClick(item));
  main.title = t.sessionResumeTitle;
  const titleRow = el("span", "session-title");
  const badge = statusBadge(item);
  if (badge) titleRow.appendChild(badge);
  titleRow.appendChild(el("span", "session-title-text", truncate(item.title, MAX_SESSION_TITLE_CHARS)));
  main.append(
    titleRow,
    el("span", "session-meta", item.timestamp?.slice(0, TIMESTAMP_CHARS).replace("T", " ") ?? ""),
  );
  row.appendChild(main);

  // Action buttons occupy fixed slots on every row; unavailable actions are
  // disabled rather than hidden. Status badges live inline before the title.
  row.appendChild(renameButton(item));
  row.appendChild(deleteButton(item));
  return row;
}

function onRowClick(item: SessionListItem): void {
  if (item.delegationRole) {
    post({ type: "showDelegationSession", target: item.delegationRole });
    hooks.close();
    return;
  }
  if (!item.current) {
    // Clicking the running session while previewing returns to the live view.
    if (state.preview && item.running) {
      post({ type: "closePreview" });
      hooks.close();
      return;
    }
    // While a run or compaction is in progress, other sessions open read-only
    // instead of replacing the active session. Preview reports both activity
    // flags as false (the visible transcript is static), so check it too.
    if (state.isStreaming || state.isCompacting || state.delegation || state.preview) {
      showLoading();
      post({ type: "previewSession", file: item.file });
      hooks.close();
      return;
    }
    hooks.onResume();
    // Loading a large session file takes the host a moment; without this the
    // previous transcript would stay on screen and read as a frozen UI.
    showLoading();
    post({ type: "resumeSession", file: item.file });
  }
  hooks.close();
}

function statusBadge(item: SessionListItem): HTMLElement | undefined {
  const badge = el("span", "session-badge");
  if (item.delegationRole === "child") {
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
  if (item.current || item.running || item.delegationRole) {
    del.disabled = true;
    del.title = t.sessionDeleteCurrentTitle;
  } else {
    del.title = t.sessionDeleteTitle;
  }
  return del;
}

function renameButton(item: SessionListItem): HTMLElement {
  const rename = button("session-rename", t.sessionRename, (event) => {
    event.stopPropagation();
    post({ type: "renameSession", file: item.file });
  });
  rename.title = t.sessionRenameTitle;
  return rename;
}
