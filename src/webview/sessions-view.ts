import type { SessionListItem } from "../shared/protocol.js";
import { button, el } from "./dom.js";
import { MAX_SESSION_TITLE_CHARS, truncate } from "./format.js";
import { post } from "./host.js";
import { getDict } from "./i18n.js";
import { sessionsEl } from "./shell.js";
import { spinner } from "./spinner.js";
import { state } from "./store.js";

/**
 * The sessions page: a full-height list replacing the chat while open.
 *
 * Showing/hiding the page is a layout decision owned by `main.ts`; this module
 * only renders the list and reports what the user picked.
 */

const t = getDict();

const TIMESTAMP_CHARS = 16; // "YYYY-MM-DDTHH:MM"

interface SessionsHooks {
  /** Leave the sessions page (layout lives in main.ts). */
  close(): void;
  /** Called before switching sessions, to drop composer state. */
  onResume(): void;
}

let hooks: SessionsHooks = { close: () => {}, onResume: () => {} };

export function initSessions(sessionsHooks: SessionsHooks): void {
  hooks = sessionsHooks;
}

export function isSessionsOpen(): boolean {
  return !sessionsEl.classList.contains("hidden");
}

export function renderSessions(items: SessionListItem[]): void {
  if (!isSessionsOpen()) return;
  sessionsEl.replaceChildren();

  const header = el("div", "sessions-header");
  header.append(el("span", undefined, t.sessionsHeader));
  sessionsEl.appendChild(header);

  if (items.length === 0) {
    sessionsEl.appendChild(el("div", "sessions-empty", t.sessionsEmpty));
    return;
  }

  for (const item of items) sessionsEl.appendChild(sessionRow(item));
}

function sessionRow(item: SessionListItem): HTMLElement {
  const row = el(
    "div",
    `session-row${item.current ? " current" : ""}${item.delegationRole ? ` delegation-${item.delegationRole}` : ""}`,
  );
  row.title = item.file;

  const main = button("session-main", undefined, () => onRowClick(item));
  main.title = t.sessionResumeTitle;
  main.append(
    el("span", "session-title", truncate(item.title, MAX_SESSION_TITLE_CHARS)),
    el("span", "session-meta", item.timestamp?.slice(0, TIMESTAMP_CHARS).replace("T", " ") ?? ""),
  );
  row.appendChild(main);

  row.appendChild(
    item.current || item.running || item.delegationRole ? statusBadge(item) : deleteButton(item),
  );
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
    // While a run is in progress, other sessions open read-only instead of
    // replacing the active session. In preview `isStreaming` is reported
    // false (the visible transcript is static), so check `preview` too.
    if (state.isStreaming || state.delegation || state.preview) {
      post({ type: "previewSession", file: item.file });
      hooks.close();
      return;
    }
    hooks.onResume();
    post({ type: "resumeSession", file: item.file });
  }
  hooks.close();
}

function statusBadge(item: SessionListItem): HTMLElement {
  const badge = el("span", "session-badge");
  if (item.delegationRole === "child") {
    badge.append(spinner(), document.createTextNode(` ${t.sessionSubagentRunning}`));
  } else if (item.delegationRole === "parent") {
    badge.textContent = t.sessionParentWaiting;
  } else if (item.running) {
    // Same braille spinner as the bottom "Working..." indicator.
    badge.append(spinner(), document.createTextNode(` ${item.current ? t.sessionCurrent : t.sessionRunning}`));
  } else if (item.current) {
    badge.textContent = state.preview ? t.sessionPreviewing : t.sessionCurrent;
  }
  return badge;
}

function deleteButton(item: SessionListItem): HTMLElement {
  const del = button("session-delete", t.sessionDelete, (event) => {
    event.stopPropagation();
    post({ type: "deleteSession", file: item.file });
  });
  del.title = t.sessionDeleteTitle;
  return del;
}
