import type { ChatState, HostMessage } from "../shared/protocol.js";
import { clearFileRefs, initComposer, onProjectFiles, send, setInput, setSlashCommands } from "./composer.js";
import { post } from "./host.js";
import { getDict } from "./i18n.js";
import { SEND_ICON, STOP_ICON } from "./icons.js";
import { hasResources, renderResources } from "./resources-view.js";
import { initSessions, isSessionsOpen, renderSessions } from "./sessions-view.js";
import {
  authEl,
  byId,
  composerEl,
  delegationBarEl,
  delegationLabelEl,
  delegationPeerBtn,
  followUpBtn,
  inputEl,
  messagesEl,
  modelBtn,
  newBtn,
  resourcesEl,
  sendBtn,
  sessionsBtn,
  sessionsEl,
  steerBtn,
  thinkingBtn,
  treeBtn,
} from "./shell.js";
import { renderStatusLine } from "./statusline.js";
import { setState, state } from "./store.js";
import { applyEvent, applyHistory, clearMessages, updateWorkingIndicator } from "./transcript.js";

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
  sessionsEl.classList.remove("hidden");
  messagesEl.classList.add("hidden");
  composerEl.classList.add("hidden");
  resourcesEl.classList.add("hidden");
  delegationBarEl.classList.add("hidden");
  updateHeaderButtons();
  post({ type: "listSessions" });
}

function closeSessions(): void {
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
  const busy = state.isStreaming || Boolean(state.delegation) || Boolean(state.preview);
  // "New" is pointless on an already-empty chat page, but on the sessions
  // page it doubles as "back to a fresh session", so keep it clickable there.
  newBtn.disabled = (emptySession && !isSessionsOpen()) || busy;
  treeBtn.disabled = emptySession || busy || isSessionsOpen();
  // On the sessions page the button is disabled; the way back to the chat is
  // picking a session row (or the current one).
  sessionsBtn.disabled = isSessionsOpen();
}

function showChat(): void {
  messagesEl.classList.remove("hidden");
  composerEl.classList.remove("hidden");
  resourcesEl.classList.toggle("hidden", !hasResources());
  delegationBarEl.classList.toggle("hidden", !state.delegation && !state.preview);
}

/**
 * When no provider is authenticated the chat is replaced by a setup page:
 * you cannot start a session without a model.
 */
function applyAuthGate(): void {
  const gated = state.ready && Boolean(state.needsAuth);
  authEl.classList.toggle("hidden", !gated);
  if (gated) {
    messagesEl.classList.add("hidden");
    composerEl.classList.add("hidden");
    resourcesEl.classList.add("hidden");
    delegationBarEl.classList.add("hidden");
    sessionsEl.classList.add("hidden");
  } else if (!isSessionsOpen()) {
    showChat();
  }
}

function renderDelegationBar(): void {
  const preview = state.preview;
  if (preview) {
    delegationBarEl.classList.remove("hidden");
    delegationLabelEl.textContent = t.previewBanner(preview.title);
    delegationPeerBtn.textContent = t.previewBack;
    return;
  }
  const delegation = state.delegation;
  delegationBarEl.classList.toggle("hidden", !delegation);
  if (!delegation) return;
  if (delegation.role === "parent") {
    delegationLabelEl.textContent = t.parentWaitingFor(delegation.title);
    delegationPeerBtn.textContent = t.viewSubagent;
  } else {
    delegationLabelEl.textContent = t.subagentRunning(delegation.title);
    delegationPeerBtn.textContent = t.viewParent;
  }
}

/* ---------------------------------------------------------------- */
/* State                                                             */
/* ---------------------------------------------------------------- */

function applyState(next: ChatState): void {
  setState(next);
  const childReadOnly = Boolean(state.inputDisabled) && !state.preview;
  const parentWaiting = state.delegation?.role === "parent";
  sendBtn.innerHTML = state.isStreaming ? STOP_ICON : SEND_ICON;
  sendBtn.title = state.isStreaming
    ? childReadOnly
      ? t.stopSubagentTitle
      : parentWaiting
        ? t.stopTaskLineTitle
        : t.stopIconTitle
    : t.sendIconTitle;
  sendBtn.classList.toggle("stop", state.isStreaming);
  inputEl.disabled = Boolean(state.inputDisabled);
  inputEl.placeholder = state.preview ? t.previewInputDisabled : childReadOnly ? t.subagentInputDisabled : t.inputPlaceholder;
  sendBtn.disabled = !state.ready || Boolean(state.preview);
  steerBtn.classList.toggle("hidden", !state.isStreaming || childReadOnly);
  followUpBtn.classList.toggle("hidden", !state.isStreaming || childReadOnly);
  steerBtn.title = parentWaiting ? t.parentSteerTitle : t.steerTitle;
  followUpBtn.title = parentWaiting ? t.parentFollowUpTitle : t.followUpTitle;
  // Model / thinking values speak for themselves; no label prefix needed.
  modelBtn.textContent = state.modelId ?? "-";
  modelBtn.title = state.providerId ? `${t.modelTitle}: ${state.providerId}/${state.modelId}` : t.modelTitle;
  thinkingBtn.textContent = state.thinkingLevel ?? "-";
  modelBtn.disabled = childReadOnly || Boolean(state.preview);
  thinkingBtn.disabled = childReadOnly || Boolean(state.preview);
  // A brand-new empty session cannot be re-created or navigated, and
  // single-task-line mode forbids switching mid-run: shown disabled.
  updateHeaderButtons();
  renderDelegationBar();
  applyAuthGate();
  renderStatusLine();
  updateWorkingIndicator();
}

/* ---------------------------------------------------------------- */
/* Wiring                                                            */
/* ---------------------------------------------------------------- */

initComposer({ beforeSend: closeSessions });
initSessions({ close: closeSessions, onResume: clearFileRefs });

/** While streaming the send button becomes a stop button. */
sendBtn.addEventListener("click", () => {
  if (state.isStreaming) post({ type: "abort" });
  else if (!state.inputDisabled) send();
});
steerBtn.addEventListener("click", () => send("steer"));
followUpBtn.addEventListener("click", () => send("followUp"));
modelBtn.addEventListener("click", () => post({ type: "pickModel" }));
thinkingBtn.addEventListener("click", () => post({ type: "pickThinkingLevel" }));
newBtn.addEventListener("click", () => {
  closeSessions();
  clearFileRefs();
  post({ type: "newSession" });
});
treeBtn.addEventListener("click", () => post({ type: "openSessionTree" }));
byId("btn-login").addEventListener("click", () => post({ type: "login" }));
byId("btn-logout").addEventListener("click", () => post({ type: "logout" }));
byId("btn-providers").addEventListener("click", () => post({ type: "login" }));
byId("btn-sessions").addEventListener("click", () => {
  if (!isSessionsOpen()) openSessions();
});
delegationPeerBtn.addEventListener("click", () => {
  if (state.preview) {
    post({ type: "closePreview" });
    return;
  }
  const role = state.delegation?.role;
  if (role) post({ type: "showDelegationSession", target: role === "parent" ? "child" : "parent" });
});

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === "state") applyState(message.state);
  else if (message.type === "event") applyEvent(message.event);
  else if (message.type === "history") applyHistory(message.events);
  else if (message.type === "sessions") renderSessions(message.items);
  else if (message.type === "commands") setSlashCommands(message.items);
  else if (message.type === "projectFiles") onProjectFiles(message.requestId, message.items, message.error);
  else if (message.type === "resources") {
    renderResources(message.sections);
    if (!state.needsAuth && !isSessionsOpen()) resourcesEl.classList.toggle("hidden", !hasResources());
  } else if (message.type === "setInput") setInput(message.text);
  else if (message.type === "clear") clearMessages();
});

post({ type: "ready" });
