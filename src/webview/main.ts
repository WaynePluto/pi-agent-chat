import type { ChatState, HostMessage } from "../shared/protocol.js";
import { clearFileRefs, initComposer, onProjectFiles, send, setInput, setSlashCommands } from "./composer.js";
import { post } from "./host.js";
import { getDict } from "./i18n.js";
import { SEND_ICON, STOP_ICON } from "./icons.js";
import { hasResources, isResourcesShown, renderResources, toggleResources } from "./resources-view.js";
import { renderExtensionWidgets } from "./widgets.js";
import { initSessions, isSessionsOpen, renderSessions } from "./sessions-view.js";
import { closePicker, openPicker, refreshPicker, setModelCatalog, togglePicker } from "./picker.js";
import { closeSearch, toggleSearch } from "./search.js";
import { createOverflowGroup } from "./overflow.js";
import {
  authEl,
  byId,
  composerActionsEl,
  composerEl,
  composerMenuEl,
  composerMoreBtn,
  delegationBarEl,
  delegationLabelEl,
  delegationPeerBtn,
  followUpBtn,
  headerActionsEl,
  headerEl,
  headerMenuEl,
  headerMoreBtn,
  headerTitleEl,
  inputEl,
  messagesWrapEl,
  modelBtn,
  newBtn,
  recallBtn,
  resourcesBtn,
  searchBtn,
  resourcesEl,
  sendBtn,
  sessionsBtn,
  sessionsEl,
  settingsBtn,
  steerBtn,
  thinkingBtn,
  treeBtn,
} from "./shell.js";
import { renderExtensionStatus, renderStatusLine, updateStatusLineFit } from "./statusline.js";
import { currentLane, isDelegating, isInLane, setState, state } from "./store.js";
import { applyEvent, applyHistory, assignEntryIds, clearMessages, hasPendingBubbles, removePendingBubbles, setEntryActionsLocked, showNewSession, updateWorkingIndicator } from "./transcript.js";

/**
 * Application shell: wires the view modules together, owns page layout
 * (chat / sessions / auth gate) and routes host messages.
 *
 * Everything else lives in a dedicated module; this file should stay small
 * enough to read in one screen-and-a-bit.
 */

const t = getDict();

/* ---------------------------------------------------------------- */
/* Page layout                                                       */
/* ---------------------------------------------------------------- */

/** The sessions page replaces the chat: hide messages, composer and Tree. */
function openSessions(): void {
  closePicker();
  closeSearch();
  sessionsEl.classList.remove("hidden");
  messagesWrapEl.classList.add("hidden");
  composerEl.classList.add("hidden");
  applyResourcesVisibility();
  delegationBarEl.classList.add("hidden");
  updateHeaderButtons();
  post({ type: "sessionsVisible", visible: true });
}

function closeSessions(): void {
  if (isSessionsOpen()) post({ type: "sessionsVisible", visible: false });
  sessionsEl.classList.add("hidden");
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
  const busy = state.isStreaming || state.isCompacting || isDelegating() || Boolean(state.preview);
  // "New" is pointless on an already-empty chat page, but on the sessions
  // page it doubles as "back to a fresh session", so keep it clickable there.
  newBtn.disabled = (emptySession && !isSessionsOpen()) || busy;
  treeBtn.disabled = emptySession || busy || isSessionsOpen();
  // On the sessions page the button is disabled; the way back to the chat is
  // picking a session row (or the current one).
  sessionsBtn.disabled = isSessionsOpen();
  // Nothing to reveal without a listing, and the panel belongs to the chat.
  resourcesBtn.disabled = !hasResources() || isSessionsOpen();
  // The transcript is the search corpus; off the chat page there is nothing to search.
  searchBtn.disabled = isSessionsOpen() || (state.ready && Boolean(state.needsAuth));
}

/**
 * The resources panel is shown only when the header toggle asks for it and
 * there is a listing to show, and never over the sessions or auth pages.
 */
function applyResourcesVisibility(): void {
  const shown = isResourcesShown();
  const gated = state.ready && Boolean(state.needsAuth);
  resourcesEl.classList.toggle("hidden", !(shown && hasResources() && !gated && !isSessionsOpen()));
  resourcesBtn.setAttribute("aria-pressed", String(shown));
  resourcesBtn.classList.toggle("active", shown);
}

function showChat(): void {
  messagesWrapEl.classList.remove("hidden");
  composerEl.classList.remove("hidden");
  applyResourcesVisibility();
  delegationBarEl.classList.toggle("hidden", !isInLane() && !state.preview);
  // The composer was unmeasurable while hidden; settle its layout now.
  updateResponsiveLayout();
}

/**
 * When no provider is authenticated the chat is replaced by a setup page:
 * you cannot start a session without a model.
 */
function applyAuthGate(): void {
  const gated = state.ready && Boolean(state.needsAuth);
  authEl.classList.toggle("hidden", !gated);
  if (gated) {
    messagesWrapEl.classList.add("hidden");
    composerEl.classList.add("hidden");
    delegationBarEl.classList.add("hidden");
    sessionsEl.classList.add("hidden");
    applyResourcesVisibility();
  } else if (!isSessionsOpen()) {
    showChat();
  }
}

/**
 * Banner above the transcript.
 *
 * Shown for a preview, and while the user is inside a subagent's transcript so
 * there is always a way back. Not shown on the parent during a run: the lane
 * card in the transcript already says everything, and duplicating it here would
 * push the conversation down for no gain.
 */
function renderDelegationBar(): void {
  const delegation = state.delegation;
  // Checked before the preview banner, not after: a subagent whose live session
  // is gone is shown by replaying its session file, so both are true at once
  // and the subagent framing is the more specific one. The generic banner would
  // offer "back to the running session" with nothing running.
  if (delegation && isInLane()) {
    delegationBarEl.classList.remove("hidden");
    const lane = currentLane();
    delegationLabelEl.textContent = t.subagentRunning(lane?.title ?? "");
    // The parent is never switched to automatically — that would yank the user
    // out of what they chose to read — so say instead that it moved on.
    delegationPeerBtn.textContent = delegation.parentHasNewActivity ? t.backToParentNew : t.backToParent;
    return;
  }
  if (state.preview) {
    delegationBarEl.classList.remove("hidden");
    delegationLabelEl.textContent = t.previewBanner;
    delegationPeerBtn.textContent = t.previewBack;
    return;
  }
  delegationBarEl.classList.add("hidden");
}

/**
 * The header title shows where the user is: the preview target, the current
 * session's display name (or first message), or a "new session" placeholder.
 * The extension name itself already appears in the VS Code view title.
 */
function renderHeaderTitle(): void {
  const text = state.preview
    ? t.previewLabel(state.preview.title)
    : state.sessionName || t.newSessionLabel;
  headerTitleEl.textContent = text;
  headerTitleEl.title = text;
}

/* ---------------------------------------------------------------- */
/* State                                                             */
/* ---------------------------------------------------------------- */

function applyState(next: ChatState): void {
  setState(next);
  renderHeaderTitle();
  const childReadOnly = Boolean(state.inputDisabled) && !state.preview;
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
  inputEl.placeholder = state.preview
    ? t.previewInputDisabled
    : childReadOnly
      ? t.subagentInputDisabled
      : state.isCompacting
        ? t.compactionInputPlaceholder
        : t.inputPlaceholder;
  sendBtn.disabled = !state.ready || Boolean(state.preview);
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
  modelBtn.disabled = childReadOnly || Boolean(state.preview);
  thinkingBtn.disabled = !canSelectThinkingLevel || childReadOnly || Boolean(state.preview);
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
  setEntryActionsLocked(active || isDelegating() || isInLane() || Boolean(state.preview));
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
  // What is left of the header once the title has been given its floor.
  available: () => {
    const style = getComputedStyle(headerEl);
    const inner = headerEl.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const titleFloor = parseFloat(getComputedStyle(headerTitleEl).minWidth) || 0;
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

// Only width matters here, and re-measuring on every height change (the input
// box is user-resizable) would be wasted work.
let lastWidth = 0;
new ResizeObserver((entries) => {
  const width = entries[0]?.contentRect.width ?? 0;
  if (Math.round(width) === lastWidth) return;
  lastWidth = Math.round(width);
  updateResponsiveLayout();
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
newBtn.addEventListener("click", () => {
  closeSessions();
  clearFileRefs();
  // A new session has no history to wait for: showing the loading spinner
  // here would flash it for the duration of one round trip.
  showNewSession();
  post({ type: "newSession" });
});
treeBtn.addEventListener("click", () => post({ type: "openSessionTree" }));
resourcesBtn.addEventListener("click", () => {
  toggleResources();
  applyResourcesVisibility();
});
searchBtn.addEventListener("click", () => toggleSearch());
byId("btn-login").addEventListener("click", () => post({ type: "login" }));
byId("btn-logout").addEventListener("click", () => post({ type: "logout" }));
byId("btn-settings").addEventListener("click", () => post({ type: "openSettings" }));
byId("btn-sessions").addEventListener("click", () => {
  if (!isSessionsOpen()) openSessions();
});
delegationPeerBtn.addEventListener("click", () => {
  // Same precedence as the banner: leaving a subagent goes back to the parent,
  // even when that subagent is being shown as a replay of its session file.
  if (isInLane()) {
    post({ type: "showLane" });
    return;
  }
  if (state.preview) post({ type: "closePreview" });
});

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === "state") applyState(message.state);
  else if (message.type === "event") {
    applyEvent(message.event);
    updateRecallButton();
  } else if (message.type === "history") applyHistory(message.events, message.live, message.systemPromptOverridden, message.subagent, message.transcriptId);
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
