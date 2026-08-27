import type { ChatState, HostMessage } from "../shared/protocol.js";
import {
  CHAT_COLUMN_MIN_WIDTH,
  CONTENT_WIDTH_MAX,
  CONTENT_WIDTH_MIN,
  DEFAULT_CONTENT_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  WIDE_GRID_CHROME_WIDTH,
} from "../shared/protocol.js";
import { clearFileRefs, initComposer, onProjectFiles, populateInputHistoryFromEvents, send, setInput, setSlashCommands } from "./composer.js";
import { getPersisted, post, setPersisted } from "./host.js";
import { setFoldMaxLines } from "./bubble.js";
import { getDict } from "./i18n.js";
import { SEND_ICON, STOP_ICON } from "./icons.js";
import { hasResources, initializeResourcesState, isResourcesShown, renderResources, toggleResources } from "./resources-view.js";
import { renderExtensionWidgets } from "./widgets.js";
import { initSessions, isSessionsVisible, renderSessions, setSessionsVisible } from "./sessions-view.js";
import { closePicker, openPicker, refreshPicker, setModelCatalog, togglePicker } from "./picker.js";
import { closeSearch, toggleSearch } from "./search.js";
import { createOverflowGroup } from "./overflow.js";
import {
  authEl,
  byId,
  chatColumnEl,
  composerActionsEl,
  composerEl,
  composerMenuEl,
  composerMoreBtn,
  delegationBarEl,
  delegationLabelEl,
  delegationPeerBtn,
  followUpBtn,
  headerActionsEl,
  headerContentEl,
  headerMenuEl,
  headerMoreBtn,
  headerTitleEl,
  inputEl,
  messagesWrapEl,
  modelBtn,
  newBtn,
  recallBtn,
  resourcesBtn,
  rootEl,
  searchBtn,
  resourcesEl,
  sendBtn,
  sessionsBtn,
  settingsBtn,
  steerBtn,
  thinkingBtn,
  treeBtn,
} from "./shell.js";
import { renderExtensionStatus, renderStatusLine, updateStatusLineFit } from "./statusline.js";
import { currentLane, isDelegating, isInLane, setState, state } from "./store.js";
import { applyEvent, applyHistory, assignEntryIds, clearMessages, hasPendingBubbles, removePendingBubbles, setEntryActionsLocked, setShowThinking, showNewSession, updateWorkingIndicator } from "./transcript.js";

/**
 * Application shell: wires the view modules together, owns page layout
 * (chat / sessions / auth gate) and routes host messages.
 *
 * Everything else lives in a dedicated module; this file should stay small
 * enough to read in one screen-and-a-bit.
 */

const t = getDict();

/**
 * Max width of the centered chat column, `piAgentChat.layout.contentMaxWidth`.
 * Restored from the webview's persisted state before the first layout: a
 * controller swap reassigns `webview.html`, and the fresh webview would
 * otherwise re-classify the viewport with the documented default until the
 * `ready` round trip delivers the configured value — wide/narrow must not
 * hinge on message timing. The default covers a genuinely first load.
 */
function initialContentMaxWidth(): number {
  const saved = getPersisted<number>("contentMaxWidth");
  if (saved === undefined || !Number.isFinite(saved)) return DEFAULT_CONTENT_MAX_WIDTH;
  return Math.min(CONTENT_WIDTH_MAX, Math.max(CONTENT_WIDTH_MIN, Math.round(saved)));
}

let contentMaxWidth = initialContentMaxWidth();
// Inline styles do not survive a webview reload, so the restored value must be
// re-applied to the custom property before first paint — otherwise the layout
// classifies the viewport with the configured width but *sizes* the columns
// with the stylesheet default until the `ready` round trip catches up.
document.documentElement.style.setProperty("--content-max-width", `${contentMaxWidth}px`);

/**
 * Wide mode turns on once the three-column grid fits at its minimum sizes:
 * the chat column at its floor, both rails at theirs, plus the grid's fixed
 * gaps and padding (geometry mirrored in `src/styles/_wide.scss`). Lowering
 * the configured column width lowers the threshold with it.
 */
function wideLayoutMinWidth(): number {
  return Math.min(CHAT_COLUMN_MIN_WIDTH, contentMaxWidth) + RAIL_MIN_WIDTH * 2 + WIDE_GRID_CHROME_WIDTH;
}

/**
 * Apply a pushed column width: it sizes the transcript, the composer and the
 * wide grid through the `--content-max-width` custom property, and moves the
 * wide-mode threshold, so the current viewport must be re-classified even
 * though its own width did not change.
 */
function applyContentMaxWidth(maxWidth: number): void {
  const width = Number.isFinite(maxWidth)
    ? Math.min(CONTENT_WIDTH_MAX, Math.max(CONTENT_WIDTH_MIN, Math.round(maxWidth)))
    : DEFAULT_CONTENT_MAX_WIDTH;
  if (width === contentMaxWidth) return;
  contentMaxWidth = width;
  document.documentElement.style.setProperty("--content-max-width", `${width}px`);
  setPersisted("contentMaxWidth", width);
  lastWidth = -1;
  applyViewportWidth(document.documentElement.clientWidth);
}

let wideLayout = false;
let sessionsPageOpen = false;
/** The sessions page and wide rail are distinct; resources deliberately are not. */
let wideSessionsShown = true;

/* ---------------------------------------------------------------- */
/* Page layout                                                       */
/* ---------------------------------------------------------------- */

/** Keep the host subscribed exactly while the narrow page or wide rail is visible. */
function setSessionListVisible(visible: boolean): void {
  const changed = visible !== isSessionsVisible();
  setSessionsVisible(visible);
  if (changed) post({ type: "sessionsVisible", visible });
}

/** On narrow surfaces the sessions page replaces the chat. */
function openSessions(): void {
  if (wideLayout) return;
  closePicker();
  closeSearch();
  sessionsPageOpen = true;
  setSessionListVisible(true);
  chatColumnEl.classList.add("hidden");
  authEl.classList.add("hidden");
  applyResourcesVisibility();
  updateHeaderButtons();
}

function closeSessions(): void {
  sessionsPageOpen = false;
  if (!wideLayout) setSessionListVisible(false);
  chatColumnEl.classList.remove("hidden");
  updateHeaderButtons();
  if (state.needsAuth) {
    applyAuthGate();
    return;
  }
  showChat();
}

/**
 * Header buttons stay visible at all times; states that previously hid them
 * now disable them (with a not-allowed cursor) instead.
 */
function updateHeaderButtons(): void {
  const emptySession = (state.messageCount ?? 0) === 0;
  const busy = state.isStreaming || state.isCompacting || isDelegating() || Boolean(state.inputDisabled);
  // "New" is pointless on an already-empty chat page, but on the sessions
  // page it doubles as "back to a fresh session", so keep it clickable there.
  // A running session does not disable it: the host detaches that controller
  // to finish in the background and gives this same surface a fresh one.
  newBtn.disabled = (emptySession && !sessionsPageOpen) || Boolean(state.inputDisabled);
  treeBtn.disabled = emptySession || busy || sessionsPageOpen;
  // The narrow sessions page disables its own entry; in wide mode the same
  // button remains live and toggles the left rail.
  sessionsBtn.disabled = !wideLayout && sessionsPageOpen;
  const sessionsShown = wideLayout ? wideSessionsShown : sessionsPageOpen;
  sessionsBtn.setAttribute("aria-pressed", String(sessionsShown));
  sessionsBtn.classList.toggle("active", sessionsShown);
  // Resources use one toggle state across both layouts.
  resourcesBtn.disabled = !hasResources() || sessionsPageOpen;
  // The transcript is the search corpus; off the chat page there is nothing to search.
  searchBtn.disabled = sessionsPageOpen || (state.ready && Boolean(state.needsAuth));
}

/**
 * The resources panel is shown only when the header toggle asks for it and
 * there is a listing to show, and never over the sessions or auth pages.
 */
function applyResourcesVisibility(): void {
  const shown = isResourcesShown();
  const gated = state.ready && Boolean(state.needsAuth);
  resourcesEl.classList.toggle("hidden", !(shown && hasResources() && !gated && !sessionsPageOpen));
  resourcesBtn.setAttribute("aria-pressed", String(shown));
  resourcesBtn.classList.toggle("active", shown);
}

function showChat(): void {
  chatColumnEl.classList.remove("hidden");
  messagesWrapEl.classList.remove("hidden");
  composerEl.classList.remove("hidden");
  applyResourcesVisibility();
  delegationBarEl.classList.toggle("hidden", !isInLane());
  // The composer was unmeasurable while hidden; settle its layout now.
  updateResponsiveLayout();
}

/**
 * When no provider is authenticated the chat is replaced by a setup page:
 * you cannot start a session without a model.
 */
function applyAuthGate(): void {
  const gated = state.ready && Boolean(state.needsAuth);
  // Match the previous narrow-page contract: authentication setup supersedes
  // an open sessions page. The wide rail is independent and stays visible.
  if (gated && sessionsPageOpen && !wideLayout) {
    sessionsPageOpen = false;
    setSessionListVisible(false);
  }
  authEl.classList.toggle("hidden", !gated || sessionsPageOpen);
  if (sessionsPageOpen) {
    chatColumnEl.classList.add("hidden");
    applyResourcesVisibility();
    return;
  }
  chatColumnEl.classList.remove("hidden");
  if (gated) {
    messagesWrapEl.classList.add("hidden");
    composerEl.classList.add("hidden");
    delegationBarEl.classList.add("hidden");
    applyResourcesVisibility();
  } else {
    showChat();
  }
}

/**
 * Banner above a subagent transcript, including a historical lane replay.
 * Not shown on the parent during a run: the lane card in the transcript already
 * says everything, and duplicating it here would push the conversation down.
 */
function renderDelegationBar(): void {
  const delegation = state.delegation;
  if (!delegation || !isInLane()) {
    delegationBarEl.classList.add("hidden");
    return;
  }
  delegationBarEl.classList.remove("hidden");
  const lane = currentLane();
  delegationLabelEl.textContent = t.subagentRunning(lane?.title ?? "");
  // The parent is never switched to automatically — that would yank the user
  // out of what they chose to read — so say instead that it moved on.
  delegationPeerBtn.textContent = delegation.parentHasNewActivity ? t.backToParentNew : t.backToParent;
}

/**
 * The header title shows where the user is: a historical subagent's title, the
 * current session's display name (or first message), or a "new session" placeholder.
 * The extension name itself already appears in the VS Code view title.
 */
function renderHeaderTitle(): void {
  const text = state.preview?.title || state.sessionName || t.newSessionLabel;
  const renamable = state.ready && !state.preview && !state.inputDisabled;
  headerTitleEl.textContent = text;
  headerTitleEl.classList.toggle("renamable", renamable);
  headerTitleEl.title = renamable ? `${text}\n${t.headerRenameTitle}` : text;
}

/* ---------------------------------------------------------------- */
/* State                                                             */
/* ---------------------------------------------------------------- */

function applyState(next: ChatState): void {
  setState(next);
  renderHeaderTitle();
  const childReadOnly = Boolean(state.inputDisabled);
  const parentWaiting = state.delegation?.role === "parent" && isDelegating();
  const active = state.isStreaming || state.isCompacting;
  sendBtn.innerHTML = active ? STOP_ICON : SEND_ICON;
  sendBtn.title = active
    ? state.isCompacting
      ? t.stopCompactionTitle
      : childReadOnly
        ? t.stopSubagentTitle
        : parentWaiting
          ? t.stopTaskLineTitle
          : t.stopIconTitle
    : t.sendIconTitle;
  sendBtn.classList.toggle("stop", active);
  inputEl.disabled = Boolean(state.inputDisabled);
  inputEl.placeholder = childReadOnly
    ? t.subagentInputDisabled
    : state.isCompacting
      ? t.compactionInputPlaceholder
      : t.inputPlaceholder;
  // A running live lane keeps the stop control active; a historical replay has
  // nothing to stop and is fully disabled.
  sendBtn.disabled = !state.ready || (childReadOnly && !active);
  steerBtn.classList.toggle("hidden", !state.isStreaming || state.isCompacting || childReadOnly);
  followUpBtn.classList.toggle("hidden", !active || childReadOnly);
  updateRecallButton();
  steerBtn.title = parentWaiting ? t.parentSteerTitle : t.steerTitle;
  followUpBtn.title = state.isCompacting
    ? t.queueAfterCompactionTitle
    : parentWaiting
      ? t.parentFollowUpTitle
      : t.followUpTitle;
  // Model / thinking values speak for themselves; no label prefix needed.
  modelBtn.textContent = state.modelId ?? "-";
  modelBtn.title = state.providerId ? `${t.modelTitle}: ${state.providerId}/${state.modelId}` : t.modelTitle;
  thinkingBtn.textContent = state.thinkingLevel ?? "-";
  // Models without selectable thinking levels report only one fixed value
  // (usually "off"); hiding the control avoids a dead-end picker.
  const canSelectThinkingLevel = (state.thinkingLevels?.length ?? 0) > 1;
  thinkingBtn.classList.toggle("hidden", !canSelectThinkingLevel);
  modelBtn.disabled = childReadOnly;
  thinkingBtn.disabled = !canSelectThinkingLevel || childReadOnly;
  // A disabled chip must not keep its popup open, and an open one has to show
  // the new current model / level.
  if (modelBtn.disabled && thinkingBtn.disabled) closePicker();
  else refreshPicker();
  // A brand-new empty session cannot be re-created or navigated, and
  // single-task-line mode forbids switching mid-run: shown disabled.
  updateHeaderButtons();
  // Per-message tree actions need a settled, live transcript to act on: not
  // while subagents run, and not while a subagent's transcript is on screen
  // (its entries are not the parent's to fork or relabel).
  setEntryActionsLocked(active || isDelegating() || isInLane());
  renderDelegationBar();
  applyAuthGate();
  renderStatusLine();
  updateWorkingIndicator();
  // Button labels and visibility just changed, so the rows may fit differently.
  updateResponsiveLayout();
}

/* ---------------------------------------------------------------- */
/* Responsive layout                                                 */
/* ---------------------------------------------------------------- */

/**
 * Secondary actions collapse into a "..." popup instead of wrapping, and the
 * status line disappears entirely, once the panel gets too narrow for them.
 * The session title keeps a minimum width (CSS) so it never vanishes first.
 */
const headerOverflow = createOverflowGroup({
  row: headerActionsEl,
  items: [newBtn, sessionsBtn, treeBtn, searchBtn, resourcesBtn, settingsBtn],
  toggle: headerMoreBtn,
  menu: headerMenuEl,
  // Editor tabs carry the title, so their hidden header title consumes no
  // budget. The auxiliary sidebar keeps the title and its minimum readable width.
  available: () => {
    const style = getComputedStyle(headerContentEl);
    const inner = headerContentEl.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const titleStyle = getComputedStyle(headerTitleEl);
    if (titleStyle.display === "none") return inner;
    const titleFloor = parseFloat(titleStyle.minWidth) || 0;
    return inner - titleFloor - (parseFloat(style.columnGap) || 0);
  },
});
const composerOverflow = createOverflowGroup({
  row: composerActionsEl,
  items: [modelBtn, thinkingBtn, steerBtn, followUpBtn, recallBtn],
  toggle: composerMoreBtn,
  menu: composerMenuEl,
  // The action row spans the composer, so its own box is the budget.
  available: () => composerActionsEl.clientWidth,
});

function updateResponsiveLayout(): void {
  headerOverflow.update();
  composerOverflow.update();
  updateStatusLineFit();
}

function setWideLayout(wide: boolean): void {
  if (wideLayout === wide) return;
  wideLayout = wide;
  rootEl.classList.toggle("layout-wide", wide);

  if (wide) {
    // A narrow full-page listing becomes a dock. Each wide rail remembers the
    // user's last toggle independently from the narrow page/panel state.
    sessionsPageOpen = false;
    setSessionListVisible(wideSessionsShown);
    chatColumnEl.classList.remove("hidden");
  } else {
    // Wide mode never carries a hidden full-page state back to a narrow panel.
    setSessionListVisible(sessionsPageOpen);
  }

  applyAuthGate();
  applyResourcesVisibility();
  updateHeaderButtons();
}

// Only width matters here, and re-measuring on every height change (the input
// box is user-resizable) would be wasted work. ResizeObserver is event-driven;
// it does not poll the surface.
let lastWidth = -1;
function applyViewportWidth(width: number): void {
  const rounded = Math.round(width);
  if (rounded === lastWidth) return;
  // A retained/hidden webview may briefly measure 0; wait for the first real
  // width before choosing the one-time resource defaults.
  if (rounded > 0) initializeResourcesState(rounded >= wideLayoutMinWidth());
  lastWidth = rounded;
  setWideLayout(rounded >= wideLayoutMinWidth());
  updateResponsiveLayout();
}

new ResizeObserver((entries) => {
  applyViewportWidth(entries[0]?.contentRect.width ?? 0);
}).observe(document.documentElement);

/* ---------------------------------------------------------------- */
/* Wiring                                                            */
/* ---------------------------------------------------------------- */

initComposer({ beforeSend: closeSessions });
initSessions({ close: closeSessions, onResume: clearFileRefs });

/** While running or compacting the send button becomes a stop button. */
sendBtn.addEventListener("click", () => {
  if (state.isStreaming || state.isCompacting) post({ type: "abort" });
  else if (!state.inputDisabled) send();
});
steerBtn.addEventListener("click", () => send("steer"));
followUpBtn.addEventListener("click", () => send("followUp"));
recallBtn.addEventListener("click", () => post({ type: "dequeue" }));

/** Visible only while queued/steering messages are still waiting. */
function updateRecallButton(): void {
  recallBtn.classList.toggle("hidden", !hasPendingBubbles() || Boolean(state.inputDisabled) || Boolean(state.preview));
}

/** CLI dequeue: recalled texts go in front of whatever is being typed. */
function prependToInput(texts: string[]): void {
  const combined = [...texts, inputEl.value].filter((part) => part.trim()).join("\n\n");
  setInput(combined);
}
modelBtn.addEventListener("click", () => togglePicker("model"));
thinkingBtn.addEventListener("click", () => togglePicker("thinking"));
headerTitleEl.addEventListener("dblclick", () => {
  if (headerTitleEl.classList.contains("renamable")) post({ type: "renameCurrentSession" });
});
newBtn.addEventListener("click", () => {
  closeSessions();
  // While this runtime is occupied the host replaces only this surface's GUI
  // controller. Do not clear the running transcript before the new one is ready.
  const preserveCurrent = state.isStreaming || state.isCompacting || isDelegating() || Boolean(state.inputDisabled);
  if (!preserveCurrent) {
    clearFileRefs();
    // A new session has no history to wait for: showing the loading spinner
    // here would flash it for the duration of one round trip.
    showNewSession();
  }
  post({ type: "newSession" });
});
treeBtn.addEventListener("click", () => post({ type: "openSessionTree" }));
resourcesBtn.addEventListener("click", () => {
  toggleResources();
  applyResourcesVisibility();
  updateHeaderButtons();
});
searchBtn.addEventListener("click", () => toggleSearch());
byId("btn-login").addEventListener("click", () => post({ type: "login" }));
byId("btn-logout").addEventListener("click", () => post({ type: "logout" }));
byId("btn-settings").addEventListener("click", () => post({ type: "openSettings" }));
byId("btn-sessions").addEventListener("click", () => {
  if (wideLayout) {
    wideSessionsShown = !wideSessionsShown;
    setSessionListVisible(wideSessionsShown);
    updateHeaderButtons();
  } else if (!sessionsPageOpen) {
    openSessions();
  }
});
delegationPeerBtn.addEventListener("click", () => {
  // A historical subagent is still framed as a lane while its session file is
  // replayed, so every visible peer action returns through this one route.
  if (isInLane()) post({ type: "showLane" });
});

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === "state") applyState(message.state);
  // No re-render of our own: the host always follows a threshold change with
  // a history replay, which is how bubbles that already exist re-decide.
  else if (message.type === "foldThreshold") setFoldMaxLines(message.maxLines);
  // No re-render of our own: the host always follows the setting change with a
  // history replay, which is how existing cards re-decide whether they open
  // expanded. Same rule as the fold threshold one line above.
  else if (message.type === "showThinking") setShowThinking(message.enabled);
  // Pure CSS-geometry config; applied where it lands, nothing to re-render.
  else if (message.type === "contentWidth") applyContentMaxWidth(message.maxWidth);
  else if (message.type === "event") {
    applyEvent(message.event);
    updateRecallButton();
  } else if (message.type === "history") {
    applyHistory(message.events, message.live, message.systemPromptOverridden, message.subagent, message.transcriptId, message.terminal);
    // Only replays the host marked as "a session became live" feed the
    // composer's ↑ history; the composer dedupes per transcript.
    if (message.populateInputHistory) populateInputHistoryFromEvents(message.transcriptId, message.events);
  }
  else if (message.type === "entryIds") assignEntryIds(message.ids, message.labels);
  else if (message.type === "sessions") renderSessions(message.items);
  else if (message.type === "models") setModelCatalog(message.catalog);
  else if (message.type === "openPicker") openPicker(message.picker);
  else if (message.type === "commands") setSlashCommands(message.items);
  else if (message.type === "projectFiles") onProjectFiles(message.requestId, message.items, message.error);
  else if (message.type === "resources") {
    renderResources(message.sections);
    applyResourcesVisibility();
    updateHeaderButtons();
  } else if (message.type === "setInput") setInput(message.text);
  else if (message.type === "extensionStatus") renderExtensionStatus(message.items);
  else if (message.type === "extensionWidgets") renderExtensionWidgets(message.items);
  else if (message.type === "dequeued") {
    removePendingBubbles();
    prependToInput(message.texts);
    updateRecallButton();
  }
  else if (message.type === "clear") clearMessages();
});

post({ type: "ready" });
applyViewportWidth(document.documentElement.clientWidth);
