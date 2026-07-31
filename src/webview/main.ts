import type {
  ChatEvent,
  ChatState,
  HostMessage,
  ProjectFileItem,
  ResourceSection,
  SessionListItem,
  SlashCommand,
  WebviewMessage,
} from "../shared/protocol.js";
import { getDict } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscodeApi = acquireVsCodeApi();
const t = getDict();

const SEND_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 1.5l5.5 5.5-1.06 1.06L8.75 4.37V14.5h-1.5V4.37L3.56 8.06 2.5 7 8 1.5z"/></svg>`;
const STOP_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/></svg>`;
const CHEVRON_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M4.44 6.03L8 9.59l3.56-3.56 1.06 1.06L8 11.71 3.38 7.09l1.06-1.06z"/></svg>`;

/** Braille spinner, same frames as the pi CLI's working indicator. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerTimer: number | undefined;
let spinnerIndex = 0;
/** Working indicator row shown at the end of the message list while streaming. */
let workingEl: HTMLElement | undefined;
let workingLabelEl: HTMLElement | undefined;

/** Queued/steering bubbles waiting to be consumed by the agent loop. */
const pendingUserBubbles: Array<{ element: HTMLElement; text: string; mode: "steer" | "followUp" }> = [];

const state: ChatState = { ready: false, isStreaming: false };

/** Streaming assistant bubble keeps raw markdown for re-render on each delta. */
interface StreamingBubble {
  element: HTMLElement;
  raw: string;
}
let assistantBubble: StreamingBubble | undefined;

/**
 * Collapsible cards render their body lazily: content is kept as raw data and
 * only turned into DOM when the card is expanded (todo item 5).
 */
interface CollapsibleCard {
  card: HTMLElement;
  statusEl: HTMLElement;
  body: HTMLElement;
  expanded: boolean;
  /** True when the current raw content is already in the DOM. */
  rendered: boolean;
  render(): void;
}

interface ThinkingCard extends CollapsibleCard {
  raw: string;
}
let thinkingCard: ThinkingCard | undefined;

interface ToolCard extends CollapsibleCard {
  argsText: string;
  bodyText: string;
  patch?: string;
  path?: string;
}
const toolCards = new Map<string, ToolCard>();

let renderScheduled = false;

const root = document.getElementById("root") as HTMLElement;
root.innerHTML = `
  <header class="header">
    <div class="header-title">${t.title} <span class="unofficial">${t.unofficial}</span></div>
    <div class="header-actions">
      <button id="btn-new" title="${t.newSessionTitle}">${t.newSession}</button>
      <button id="btn-sessions" title="${t.sessionsTitle}">${t.sessions}</button>
      <button id="btn-tree" title="${t.treeTitle}">${t.tree}</button>
      <button id="btn-providers" title="${t.providersTitle}">${t.providers}</button>
    </div>
  </header>
  <div id="sessions" class="sessions hidden"></div>
  <div id="auth" class="auth-page hidden">
    <div class="auth-title">${t.authTitle}</div>
    <div class="auth-body">${t.authBody}</div>
    <div class="auth-actions">
      <button id="btn-login">${t.authLogin}</button>
      <button id="btn-logout" class="secondary">${t.authLogout}</button>
    </div>
  </div>
  <div id="resources" class="resources hidden"></div>
  <div id="delegation-bar" class="delegation-bar hidden">
    <span id="delegation-label"></span>
    <button id="delegation-peer" class="secondary"></button>
  </div>
  <div class="messages-wrap">
    <main id="messages" class="messages"></main>
    <button id="scroll-down" class="scroll-down hidden" title="${t.scrollDownTitle}">${CHEVRON_ICON}</button>
  </div>
  <footer id="composer" class="composer">
    <div id="autocomplete" class="autocomplete hidden"></div>
    <div id="file-refs" class="file-refs hidden"></div>
    <div id="resize-handle" class="resize-handle"></div>
    <textarea id="input" rows="3" placeholder="${t.inputPlaceholder}"></textarea>
    <div class="composer-actions">
      <button id="btn-model" class="chip" title="${t.modelTitle}">-</button>
      <button id="btn-thinking" class="chip" title="${t.thinkingTitle}">-</button>
      <span class="spacer"></span>
      <button id="btn-steer" class="secondary hidden" title="${t.steerTitle}">${t.steer}</button>
      <button id="btn-followup" class="secondary hidden" title="${t.followUpTitle}">${t.followUp}</button>
      <button id="btn-send" class="icon-button" title="${t.sendIconTitle}">${SEND_ICON}</button>
    </div>
    <div id="statusline" class="statusline"></div>
  </footer>
`;

const messagesEl = byId("messages");
const inputEl = byId<HTMLTextAreaElement>("input");
const sessionsEl = byId("sessions");
const composerEl = byId("composer");
const sendBtn = byId<HTMLButtonElement>("btn-send");
const steerBtn = byId<HTMLButtonElement>("btn-steer");
const followUpBtn = byId<HTMLButtonElement>("btn-followup");
const modelBtn = byId<HTMLButtonElement>("btn-model");
const thinkingBtn = byId<HTMLButtonElement>("btn-thinking");
const newBtn = byId<HTMLButtonElement>("btn-new");
const treeBtn = byId<HTMLButtonElement>("btn-tree");
const autocompleteEl = byId("autocomplete");
const fileRefsEl = byId("file-refs");
const resizeHandleEl = byId("resize-handle");
const statusLineEl = byId("statusline");
const resourcesEl = byId("resources");
const authEl = byId("auth");
const delegationBarEl = byId("delegation-bar");
const delegationLabelEl = byId("delegation-label");
const delegationPeerBtn = byId<HTMLButtonElement>("delegation-peer");
const scrollDownBtn = byId<HTMLButtonElement>("scroll-down");

/**
 * Sticky auto-scroll: only follow new content while the user is at (or near)
 * the bottom. Scrolling up detaches; the floating arrow re-attaches.
 */
let followBottom = true;

function isNearBottom(): boolean {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
}

messagesEl.addEventListener("scroll", () => {
  followBottom = isNearBottom();
  updateScrollDownButton(false);
});

scrollDownBtn.addEventListener("click", () => {
  followBottom = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  updateScrollDownButton(false);
  // The scroll event fires asynchronously; re-check on the next frame.
  requestAnimationFrame(() => updateScrollDownButton(false));
});

function updateScrollDownButton(hasNews: boolean): void {
  // Hidden while following the latest messages or already at the bottom.
  if (followBottom || isNearBottom()) {
    scrollDownBtn.style.display = "none";
    scrollDownBtn.classList.remove("news");
    return;
  }
  scrollDownBtn.style.display = "inline-flex";
  if (hasNews) scrollDownBtn.classList.add("news");
}

byId("btn-login").addEventListener("click", () => post({ type: "login" }));
byId("btn-logout").addEventListener("click", () => post({ type: "logout" }));
delegationPeerBtn.addEventListener("click", () => {
  const role = state.delegation?.role;
  if (role) post({ type: "showDelegationSession", target: role === "parent" ? "child" : "parent" });
});

/** `/` autocomplete state: full catalogue, current matches and selection. */
let slashCommands: SlashCommand[] = [];
let matches: SlashCommand[] = [];
let selectedIndex = 0;

/* `@` project-file picker state. */
const MAX_FILE_REFS = 10; // keep in sync with MAX_FILE_REFERENCES in project-files.ts
let acMode: "slash" | "file" = "slash";
let fileMatches: ProjectFileItem[] = [];
let fileIncludeIgnored = false;
let fileRequestId = 0;
let fileQueryTimer: number | undefined;
/** Selected references shown as removable chips above the input. */
const fileRefs: ProjectFileItem[] = [];

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
byId("btn-providers").addEventListener("click", () => post({ type: "login" }));
byId("btn-sessions").addEventListener("click", () => {
  if (sessionsEl.classList.contains("hidden")) openSessions();
  else closeSessions();
});

inputEl.addEventListener("keydown", (event) => {
  // Toggle gitignored files whenever the caret is on an @token, even if the
  // panel closed itself because the current filter had no matches.
  if (event.key === "ArrowRight" && event.ctrlKey && currentFilePrefix() !== undefined) {
    event.preventDefault();
    fileIncludeIgnored = !fileIncludeIgnored;
    requestFileMatches();
    return;
  }
  if (isAutocompleteOpen()) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      acceptCompletion();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeAutocomplete();
      return;
    }
  }
  if (event.key === "Enter") {
    // Ctrl+Enter inserts a newline (Shift+Enter does so natively); only a
    // plain Enter sends.
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const { selectionStart, selectionEnd, value } = inputEl;
      inputEl.value = `${value.slice(0, selectionStart)}\n${value.slice(selectionEnd)}`;
      inputEl.selectionStart = inputEl.selectionEnd = selectionStart + 1;
      return;
    }
    if (!event.shiftKey) {
      event.preventDefault();
      send(state.isStreaming ? "followUp" : undefined);
    }
  }
});

inputEl.addEventListener("input", () => updateAutocomplete());
inputEl.addEventListener("blur", () => window.setTimeout(closeAutocomplete, 120));

/* Composer resize: drag the top edge up/down instead of a corner grip. */
resizeHandleEl.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  resizeHandleEl.setPointerCapture(event.pointerId);
  const startY = event.clientY;
  const startHeight = inputEl.offsetHeight;
  const onMove = (move: PointerEvent) => {
    const height = Math.min(Math.max(startHeight + (startY - move.clientY), 48), window.innerHeight * 0.6);
    inputEl.style.height = `${height}px`;
  };
  const onUp = () => {
    resizeHandleEl.removeEventListener("pointermove", onMove);
    resizeHandleEl.removeEventListener("pointerup", onUp);
  };
  resizeHandleEl.addEventListener("pointermove", onMove);
  resizeHandleEl.addEventListener("pointerup", onUp);
});

window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  if (message.type === "state") applyState(message.state);
  else if (message.type === "event") applyEvent(message.event);
  else if (message.type === "history") applyHistory(message.events);
  else if (message.type === "sessions") renderSessions(message.items);
  else if (message.type === "commands") slashCommands = message.items;
  else if (message.type === "projectFiles") onProjectFiles(message.requestId, message.items, message.error);
  else if (message.type === "resources") renderResources(message.sections);
  else if (message.type === "setInput") setInput(message.text);
  else if (message.type === "clear") clearMessages();
});

post({ type: "ready" });

function send(streamingBehavior?: "steer" | "followUp"): void {
  if (state.inputDisabled) return;
  const text = inputEl.value.trim();
  const references = fileRefs.map((item) => item.path);
  if (!text && references.length === 0) return;
  inputEl.value = "";
  fileRefs.length = 0;
  renderFileRefs();
  closeAutocomplete();
  closeSessions();
  followBottom = true;
  updateScrollDownButton(false);
  post({ type: "prompt", text, references: references.length ? references : undefined, streamingBehavior });
}

/** Replace the composer content, e.g. after forking away from a user message. */
function setInput(text: string): void {
  inputEl.value = text;
  closeAutocomplete();
  inputEl.focus();
  inputEl.setSelectionRange(text.length, text.length);
}

/* ---------------------------------------------------------------- */
/* Slash command autocomplete                                        */
/* ---------------------------------------------------------------- */

function isAutocompleteOpen(): boolean {
  return !autocompleteEl.classList.contains("hidden");
}

/** The command list only triggers on a leading `/`, like the CLI editor. */
function currentCommandPrefix(): string | undefined {
  const value = inputEl.value;
  if (!value.startsWith("/")) return undefined;
  const firstSpace = value.indexOf(" ");
  if (firstSpace !== -1) return undefined;
  return value.slice(1);
}

function updateAutocomplete(): void {
  const filePrefix = currentFilePrefix();
  if (filePrefix !== undefined) {
    acMode = "file";
    scheduleFileQuery(filePrefix);
    return;
  }
  acMode = "slash";
  const prefix = currentCommandPrefix();
  if (prefix === undefined) {
    closeAutocomplete();
    return;
  }
  matches = filterCommands(prefix);
  if (matches.length === 0) {
    closeAutocomplete();
    return;
  }
  selectedIndex = 0;
  renderAutocomplete();
}

/* ---------------------------------------------------------------- */
/* `@` project-file picker                                           */
/* ---------------------------------------------------------------- */

/** The file picker triggers on an `@token` touching the caret (start or after whitespace). */
function currentFilePrefix(): string | undefined {
  if (state.inputDisabled) return undefined;
  const caret = inputEl.selectionStart ?? inputEl.value.length;
  const before = inputEl.value.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  return match ? match[1] : undefined;
}

/** Debounced host round-trip; stale responses are dropped via requestId. */
function scheduleFileQuery(query: string): void {
  if (fileQueryTimer !== undefined) window.clearTimeout(fileQueryTimer);
  fileQueryTimer = window.setTimeout(() => {
    fileQueryTimer = undefined;
    if (currentFilePrefix() === undefined) return;
    post({ type: "listProjectFiles", requestId: ++fileRequestId, query, includeIgnored: fileIncludeIgnored });
  }, 80);
}

function requestFileMatches(): void {
  const prefix = currentFilePrefix();
  if (prefix === undefined) return;
  post({ type: "listProjectFiles", requestId: ++fileRequestId, query: prefix, includeIgnored: fileIncludeIgnored });
}

function onProjectFiles(requestId: number, items: ProjectFileItem[], error?: string): void {
  if (requestId !== fileRequestId || currentFilePrefix() === undefined) return;
  const chosen = new Set(fileRefs.map((item) => item.path));
  fileMatches = items.filter((item) => !chosen.has(item.path));
  if (error) {
    closeAutocomplete();
    return;
  }
  // Keep the panel open even with no matches: the hint row explains how to
  // toggle gitignored files (Ctrl+→), which may be exactly what is missing.
  acMode = "file";
  selectedIndex = 0;
  renderFileAutocomplete();
}

function renderFileAutocomplete(): void {
  autocompleteEl.replaceChildren();

  const hint = document.createElement("div");
  hint.className = "autocomplete-hint";
  hint.textContent = fileIncludeIgnored ? t.fileHintIgnoredShown : t.fileHintIgnoredHidden;
  autocompleteEl.appendChild(hint);

  fileMatches.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = `autocomplete-row${index === selectedIndex ? " selected" : ""}`;

    const name = document.createElement("span");
    name.className = "autocomplete-name";
    name.textContent = item.path;

    row.appendChild(name);
    if (item.ignored) {
      const kind = document.createElement("span");
      kind.className = "autocomplete-kind";
      kind.textContent = t.fileIgnoredBadge;
      row.appendChild(kind);
    }
    if (item.sensitive) {
      const kind = document.createElement("span");
      kind.className = "autocomplete-kind sensitive";
      kind.textContent = t.fileSensitiveBadge;
      row.appendChild(kind);
    }

    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectedIndex = index;
      acceptCompletion();
    });
    autocompleteEl.appendChild(row);
  });
  autocompleteEl.classList.remove("hidden");
  autocompleteEl.children[selectedIndex + 1]?.scrollIntoView({ block: "nearest" });
}

/** Replace the `@token` at the caret with nothing and add a chip instead. */
function acceptFileCompletion(): void {
  const item = fileMatches[selectedIndex];
  if (!item) {
    // Empty panel (hint-only): just dismiss it.
    closeAutocomplete();
    return;
  }
  if (fileRefs.length >= MAX_FILE_REFS) {
    closeAutocomplete();
    return;
  }
  const caret = inputEl.selectionStart ?? inputEl.value.length;
  const before = inputEl.value.slice(0, caret);
  const match = /(?:^|\s)@[^\s@]*$/.exec(before);
  if (match) {
    const start = match.index + (match[0].startsWith("@") ? 0 : 1);
    inputEl.value = inputEl.value.slice(0, start) + inputEl.value.slice(caret);
    inputEl.selectionStart = inputEl.selectionEnd = start;
  }
  fileRefs.push(item);
  renderFileRefs();
  closeAutocomplete();
  inputEl.focus();
}

function clearFileRefs(): void {
  fileRefs.length = 0;
  renderFileRefs();
}

function renderFileRefs(): void {
  fileRefsEl.replaceChildren();
  fileRefsEl.classList.toggle("hidden", fileRefs.length === 0);
  for (const item of fileRefs) {
    const chip = document.createElement("span");
    chip.className = `file-ref-chip${item.ignored ? " ignored" : ""}${item.sensitive ? " sensitive" : ""}`;
    chip.title = [item.path, item.ignored ? t.fileIgnoredBadge : "", item.sensitive ? t.fileSensitiveBadge : ""]
      .filter(Boolean)
      .join(" · ");

    const label = document.createElement("span");
    label.className = "file-ref-label";
    label.textContent = `@${item.path}`;

    const remove = document.createElement("button");
    remove.className = "file-ref-remove";
    remove.textContent = "×";
    remove.title = t.fileRemoveTitle;
    remove.addEventListener("click", () => {
      const index = fileRefs.indexOf(item);
      if (index !== -1) fileRefs.splice(index, 1);
      renderFileRefs();
      inputEl.focus();
    });

    chip.append(label, remove);
    fileRefsEl.appendChild(chip);
  }
}

/** Prefix matches first, then substring matches; both alphabetical. */
function filterCommands(prefix: string): SlashCommand[] {
  const needle = prefix.toLowerCase();
  const starts: SlashCommand[] = [];
  const contains: SlashCommand[] = [];
  for (const command of slashCommands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) starts.push(command);
    else if (needle && name.includes(needle)) contains.push(command);
  }
  return [...starts, ...contains].slice(0, 50);
}

function renderAutocomplete(): void {
  autocompleteEl.replaceChildren();
  matches.forEach((command, index) => {
    const row = document.createElement("div");
    row.className = `autocomplete-row${index === selectedIndex ? " selected" : ""}`;

    const name = document.createElement("span");
    name.className = "autocomplete-name";
    name.textContent = `/${command.name}`;

    const kind = document.createElement("span");
    kind.className = `autocomplete-kind ${command.kind}`;
    kind.textContent = command.kind;

    const description = document.createElement("span");
    description.className = "autocomplete-description";
    description.textContent = [command.argumentHint, command.description].filter(Boolean).join("  ");

    row.append(name, kind, description);
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectedIndex = index;
      acceptCompletion();
    });
    autocompleteEl.appendChild(row);
  });
  autocompleteEl.classList.remove("hidden");
}

function moveSelection(delta: number): void {
  const total = acMode === "file" ? fileMatches.length : matches.length;
  if (total === 0) return;
  selectedIndex = (selectedIndex + delta + total) % total;
  if (acMode === "file") renderFileAutocomplete();
  else {
    renderAutocomplete();
    autocompleteEl.children[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }
}

function acceptCompletion(): void {
  if (acMode === "file") {
    acceptFileCompletion();
    return;
  }
  const command = matches[selectedIndex];
  if (!command) return;
  // Commands without arguments can be sent right away; otherwise wait for input.
  inputEl.value = command.argumentHint ? `/${command.name} ` : `/${command.name}`;
  closeAutocomplete();
  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
}

function closeAutocomplete(): void {
  autocompleteEl.classList.add("hidden");
  matches = [];
  fileMatches = [];
  if (fileQueryTimer !== undefined) {
    window.clearTimeout(fileQueryTimer);
    fileQueryTimer = undefined;
  }
}

function post(message: WebviewMessage): void {
  vscodeApi.postMessage(message);
}

/* ---------------------------------------------------------------- */
/* State + CLI-style status line                                     */
/* ---------------------------------------------------------------- */

function applyState(next: ChatState): void {
  Object.assign(state, next);
  const childReadOnly = Boolean(state.inputDisabled);
  const parentWaiting = state.delegation?.role === "parent";
  sendBtn.disabled = !state.ready;
  sendBtn.innerHTML = state.isStreaming ? STOP_ICON : SEND_ICON;
  sendBtn.title = state.isStreaming
    ? childReadOnly
      ? t.stopSubagentTitle
      : parentWaiting
        ? t.stopTaskLineTitle
        : t.stopIconTitle
    : t.sendIconTitle;
  sendBtn.classList.toggle("stop", state.isStreaming);
  inputEl.disabled = childReadOnly;
  inputEl.placeholder = childReadOnly ? t.subagentInputDisabled : t.inputPlaceholder;
  steerBtn.classList.toggle("hidden", !state.isStreaming || childReadOnly);
  followUpBtn.classList.toggle("hidden", !state.isStreaming || childReadOnly);
  steerBtn.title = parentWaiting ? t.parentSteerTitle : t.steerTitle;
  followUpBtn.title = parentWaiting ? t.parentFollowUpTitle : t.followUpTitle;
  // Model / thinking values speak for themselves; no label prefix needed.
  modelBtn.textContent = state.modelId ?? "-";
  modelBtn.title = state.providerId ? `${t.modelTitle}: ${state.providerId}/${state.modelId}` : t.modelTitle;
  thinkingBtn.textContent = state.thinkingLevel ?? "-";
  modelBtn.disabled = childReadOnly;
  thinkingBtn.disabled = childReadOnly;
  // A brand-new empty session cannot be re-created or navigated: hide both.
  // Single-task-line mode: while streaming, arbitrary session switching is not allowed.
  const emptySession = (state.messageCount ?? 0) === 0;
  newBtn.classList.toggle("hidden", emptySession || state.isStreaming || Boolean(state.delegation));
  treeBtn.classList.toggle("hidden", emptySession || state.isStreaming || Boolean(state.delegation) || !sessionsEl.classList.contains("hidden"));
  renderDelegationBar();
  applyAuthGate();
  renderStatusLine();
  updateWorkingIndicator();
}

function renderDelegationBar(): void {
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

/** CLI-style working row, specialized while a child session is active. */
function updateWorkingIndicator(): void {
  if (state.isStreaming) {
    if (!workingEl) {
      workingEl = document.createElement("div");
      workingEl.className = "working-row";
      const spinner = document.createElement("span");
      spinner.className = "working-spinner";
      spinner.textContent = SPINNER_FRAMES[spinnerIndex]!;
      workingLabelEl = document.createElement("span");
      workingEl.append(spinner, workingLabelEl);
    }
    if (workingLabelEl) {
      workingLabelEl.textContent = state.delegation?.role === "parent"
        ? ` ${t.waitingForSubagent}`
        : state.delegation?.role === "child"
          ? ` ${t.subagentWorking}`
          : ` ${t.streaming}`;
    }
    messagesEl.appendChild(workingEl); // re-append to keep it last
    spinnerTimer ??= window.setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
      // Update every spinner on the page (working row + sessions list badge).
      for (const spinner of document.querySelectorAll(".working-spinner")) {
        spinner.textContent = SPINNER_FRAMES[spinnerIndex]!;
      }
    }, 80);
    scrollToEnd();
  } else {
    workingEl?.remove();
    workingEl = undefined;
    workingLabelEl = undefined;
    if (spinnerTimer !== undefined) {
      window.clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
  }
}

/** Bottom line mirroring the pi CLI footer: tokens, cache, cost, context. */
function renderStatusLine(): void {
  statusLineEl.replaceChildren();

  if (state.error) {
    const row = document.createElement("div");
    row.className = "statusline-row error";
    row.textContent = state.error;
    statusLineEl.appendChild(row);
    return;
  }
  if (!state.ready) {
    const row = document.createElement("div");
    row.className = "statusline-row";
    row.textContent = t.starting;
    statusLineEl.appendChild(row);
    return;
  }

  const stats = state.stats;
  if (!stats) return;
  const parts: string[] = [
    `\u2191${formatTokens(stats.inputTokens)} \u2193${formatTokens(stats.outputTokens)}`,
    `R${formatTokens(stats.cacheRead)} W${formatTokens(stats.cacheWrite)}`,
  ];
  if (stats.cacheHitPercent !== undefined) parts.push(`CH${stats.cacheHitPercent.toFixed(1)}%`);
  parts.push(`$${stats.cost.toFixed(3)}`);
  if (stats.contextPercent !== undefined && stats.contextWindow) {
    parts.push(`${stats.contextPercent.toFixed(1)}%/${formatTokens(stats.contextWindow)}`);
  }
  const bottom = document.createElement("div");
  bottom.className = "statusline-row";
  const left = document.createElement("span");
  left.textContent = parts.join("  ");
  bottom.append(left);
  statusLineEl.appendChild(bottom);
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

/* ---------------------------------------------------------------- */
/* Event rendering                                                   */
/* ---------------------------------------------------------------- */

function applyEvent(event: ChatEvent): void {
  switch (event.kind) {
    case "user_message":
      appendUserBubble(event.text, event.mode);
      break;
    case "assistant_start":
      assistantBubble = undefined;
      finishThinkingCard();
      break;
    case "text_delta":
      // Text starting means the thinking phase (if any) is over.
      finishThinkingCard();
      assistantBubble ??= createStreamingBubble("assistant");
      assistantBubble.raw += event.delta;
      scheduleRender();
      break;
    case "thinking_delta":
      thinkingCard ??= createThinkingCard(true);
      thinkingCard.raw += event.delta;
      thinkingCard.rendered = false;
      scheduleRender();
      break;
    case "thinking_message": {
      const card = createThinkingCard(false);
      card.raw = event.text;
      card.rendered = false;
      finishCard(card);
      thinkingCard = undefined;
      break;
    }
    case "assistant_message":
      appendMarkdownBubble("assistant", event.text);
      assistantBubble = undefined;
      break;
    case "assistant_end":
      flushStreaming();
      finishThinkingCard();
      assistantBubble = undefined;
      break;
    case "tool_start":
      startToolCard(event.id, event.name, event.args);
      break;
    case "tool_update": {
      const card = toolCards.get(event.id);
      if (card && event.text) {
        card.bodyText = event.text;
        card.rendered = false;
        if (card.expanded) scheduleRender();
      }
      break;
    }
    case "tool_end":
      endToolCard(event);
      break;
    case "agent_start":
      assistantBubble = undefined;
      break;
    case "agent_end":
      flushStreaming();
      finishThinkingCard();
      assistantBubble = undefined;
      // Anything still marked pending was consumed or dropped by now.
      while (pendingUserBubbles.length > 0) normalizeUserBubble(pendingUserBubbles.pop()!.element);
      break;
    case "queue_update":
      reconcilePendingBubbles(event.steering, event.followUp);
      break;
    case "status":
      appendNoticeCard("status", event.text);
      break;
    case "error":
      appendNoticeCard("error", event.text);
      break;
  }
  messagesEl.querySelector(".empty-session")?.remove();
  scrollToEnd();
}

function applyHistory(events: ChatEvent[]): void {
  clearMessages();
  followBottom = true;
  for (const event of events) applyEvent(event);
  if (events.length === 0) appendBubble("status", t.emptySession).classList.add("empty-session");
  scrollToEnd();
}

function appendBubble(role: string, text: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = `bubble ${role}`;
  wrapper.textContent = text;
  messagesEl.appendChild(wrapper);
  return wrapper;
}

function appendMarkdownBubble(role: string, text: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = `bubble markdown ${role}`;
  wrapper.appendChild(renderMarkdown(text));
  messagesEl.appendChild(wrapper);
  return wrapper;
}

/**
 * User message; queued (follow-up) and steering messages get a badge and a
 * distinct accent so they read differently from immediate prompts.
 */
function appendUserBubble(text: string, mode?: "steer" | "followUp"): void {
  const wrapper = appendMarkdownBubble("user", text);
  if (!mode) return;
  wrapper.classList.add(mode === "steer" ? "steered" : "queued");
  const badge = document.createElement("span");
  badge.className = "bubble-badge";
  badge.textContent = mode === "steer" ? t.steerBadge : t.queuedBadge;
  wrapper.prepend(badge);
  pendingUserBubbles.push({ element: wrapper, text, mode });
}

/**
 * Once a queued/steering message is consumed by the agent loop it becomes a
 * normal part of the conversation: drop the badge and the accent styling,
 * and move it to its natural position (before the content that follows it).
 * `queue_update` carries the texts still waiting, so anything absent from the
 * matching queue has been consumed.
 */
function reconcilePendingBubbles(steering: string[], followUp: string[]): void {
  for (let i = pendingUserBubbles.length - 1; i >= 0; i -= 1) {
    const pending = pendingUserBubbles[i]!;
    const queue = pending.mode === "steer" ? steering : followUp;
    if (queue.includes(pending.text)) continue;
    normalizeUserBubble(pending.element);
    // Anchor it at the current end of the transcript: subsequent output
    // belongs to this message, so it must no longer float.
    messagesEl.appendChild(pending.element);
    pendingUserBubbles.splice(i, 1);
  }
}

function normalizeUserBubble(element: HTMLElement): void {
  element.classList.remove("queued", "steered");
  element.querySelector(".bubble-badge")?.remove();
}

function createStreamingBubble(role: string): StreamingBubble {
  const element = document.createElement("div");
  element.className = `bubble markdown ${role}`;
  messagesEl.appendChild(element);
  return { element, raw: "" };
}

/**
 * Status / error notices (retry, compaction, command feedback) render as
 * collapsed one-line cards; expanding shows the full text.
 */
function appendNoticeCard(kind: "status" | "error", text: string): void {
  const firstLine = text.split("\n")[0] ?? "";
  const short = firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
  // Nothing hidden behind the fold: render a flat, non-expandable card.
  if (short === text) {
    const card = document.createElement("div");
    card.className = `notice-card flat ${kind}`;
    const label = document.createElement("span");
    label.className = "card-label";
    label.textContent = text;
    card.appendChild(label);
    messagesEl.appendChild(card);
    return;
  }
  createCard(`notice-card ${kind}`, short, "", (body) => {
    const pre = document.createElement("pre");
    pre.className = "notice-body";
    pre.textContent = text;
    body.replaceChildren(pre);
  });
}

/* ---------------------------------------------------------------- */
/* Collapsible cards (thinking + tools), lazily rendered             */
/* ---------------------------------------------------------------- */

/**
 * Build a collapsed card with a single header row:
 * `label - status ......................... chevron`
 * The body is only rendered when the user expands the card.
 */
function createCard(className: string, label: string, status: string, render: (body: HTMLElement) => void): CollapsibleCard {
  const card = document.createElement("div");
  card.className = `${className} collapsed`;

  const header = document.createElement("button");
  header.type = "button";
  header.className = "card-header";
  const labelEl = document.createElement("span");
  labelEl.className = "card-label";
  labelEl.textContent = label;
  const statusEl = document.createElement("span");
  statusEl.className = "card-status";
  statusEl.textContent = status;
  const pulse = document.createElement("span");
  pulse.className = "card-pulse";
  const chevron = document.createElement("span");
  chevron.className = "card-chevron";
  chevron.innerHTML = CHEVRON_ICON;
  header.append(labelEl, statusEl, pulse, chevron);

  const body = document.createElement("div");
  body.className = "card-body";

  const entry: CollapsibleCard = {
    card,
    statusEl,
    body,
    expanded: false,
    rendered: false,
    render() {
      if (this.rendered) return;
      render(body);
      this.rendered = true;
    },
  };

  header.addEventListener("click", () => {
    entry.expanded = !entry.expanded;
    card.classList.toggle("collapsed", !entry.expanded);
    if (entry.expanded) entry.render();
  });

  card.append(header, body);
  messagesEl.appendChild(card);
  return entry;
}

function createThinkingCard(streaming: boolean): ThinkingCard {
  const entry = createCard("thinking-card", streaming ? t.thinkingHeader : t.thinkingDone, "", (body) => {
    body.replaceChildren(renderMarkdown(card.raw));
  }) as ThinkingCard;
  const card = entry;
  card.raw = "";
  if (streaming) card.card.classList.add("streaming");
  return card;
}

/** Freeze the active thinking card: stop the pulse and relabel it. */
function finishThinkingCard(): void {
  if (!thinkingCard) return;
  finishCard(thinkingCard);
  thinkingCard = undefined;
}

function finishCard(card: ThinkingCard): void {
  card.card.classList.remove("streaming");
  const label = card.card.querySelector(".card-label");
  if (label) label.textContent = t.thinkingDone;
  if (card.expanded) card.render();
}

function startToolCard(id: string, name: string, args: unknown): void {
  const entry = createCard("tool-card", name, t.running, (body) => {
    renderToolBody(toolCards.get(id) ?? (entry as ToolCard), body);
  }) as ToolCard;
  entry.card.classList.add("running", "streaming");
  entry.argsText = summarizeArgs(args);
  entry.bodyText = "";
  toolCards.set(id, entry);
}

function endToolCard(event: Extract<ChatEvent, { kind: "tool_end" }>): void {
  // History replay has no preceding `tool_start`, so create the card on demand.
  if (!toolCards.has(event.id)) startToolCard(event.id, event.name, event.args);
  const entry = toolCards.get(event.id);
  if (!entry) return;

  entry.statusEl.textContent = event.isError ? t.errorLabel : t.done;
  entry.card.classList.remove("running", "streaming");
  entry.card.classList.toggle("error", event.isError);
  entry.bodyText = event.text;
  entry.patch = event.patch;
  entry.path = event.path;
  entry.rendered = false;
  if (entry.expanded) entry.render();
  toolCards.delete(event.id);
}

/** Full body of a tool card: args summary + output text or diff + actions. */
function renderToolBody(entry: ToolCard, body: HTMLElement): void {
  body.replaceChildren();
  if (entry.argsText) {
    const args = document.createElement("div");
    args.className = "tool-args";
    args.textContent = entry.argsText;
    body.appendChild(args);
  }
  if (entry.patch) {
    const diff = document.createElement("div");
    diff.appendChild(renderPatch(entry.patch));
    body.appendChild(diff);
    if (entry.path) {
      const actions = document.createElement("div");
      actions.className = "tool-actions";
      actions.append(
        actionButton("Open diff", () => post({ type: "openDiff", path: entry.path ?? "", patch: entry.patch ?? "" })),
        actionButton("Open file", () => post({ type: "openFile", path: entry.path ?? "" })),
      );
      body.appendChild(actions);
    }
  } else if (entry.bodyText) {
    const pre = document.createElement("pre");
    pre.className = "tool-body";
    pre.textContent = truncate(entry.bodyText, 4000);
    body.appendChild(pre);
  }
}

/** Re-render streaming content at most once per frame while deltas arrive. */
function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    flushStreaming();
    scrollToEnd();
  });
}

function flushStreaming(): void {
  if (assistantBubble) assistantBubble.element.replaceChildren(renderMarkdown(assistantBubble.raw));
  // Collapsed cards keep their raw text unrendered on purpose (todo item 5).
  if (thinkingCard?.expanded) {
    thinkingCard.rendered = false;
    thinkingCard.render();
  }
  for (const card of toolCards.values()) {
    if (card.expanded && !card.rendered) card.render();
  }
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "secondary";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

/** Render a unified patch with per-line coloring, hiding the file headers. */
function renderPatch(patch: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = patch.split("\n").filter((line) => !/^(---|\+\+\+|diff |index )/.test(line));
  for (const line of lines.slice(0, 400)) {
    const row = document.createElement("div");
    row.className = "diff-line";
    if (line.startsWith("+")) row.classList.add("added");
    else if (line.startsWith("-")) row.classList.add("removed");
    else if (line.startsWith("@@")) row.classList.add("hunk");
    row.textContent = line || " ";
    fragment.appendChild(row);
  }
  if (lines.length > 400) {
    const more = document.createElement("div");
    more.className = "diff-line hunk";
    more.textContent = `... ${lines.length - 400} more lines`;
    fragment.appendChild(more);
  }
  return fragment;
}

/* ---------------------------------------------------------------- */
/* Auth gate + startup resources                                     */
/* ---------------------------------------------------------------- */

/**
 * When no provider is authenticated the chat is replaced by a setup page:
 * you cannot start a session without a model (todo item 3).
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
  } else if (sessionsEl.classList.contains("hidden")) {
    messagesEl.classList.remove("hidden");
    composerEl.classList.remove("hidden");
    resourcesEl.classList.toggle("hidden", !resourcesEl.hasChildNodes());
    delegationBarEl.classList.toggle("hidden", !state.delegation);
  }
}

/**
 * CLI-style startup listing ([Context] / [Skills] / ...), pinned above the
 * transcript as one bordered, fully collapsible panel. Default state is
 * collapsed: only a slim one-line header is visible. Expanding shows the
 * sections; each section can further expand to full file paths.
 */
let resourcesExpanded = false;

function renderResources(sections: ResourceSection[]): void {
  resourcesEl.replaceChildren();
  if (sections.length === 0) {
    resourcesEl.classList.add("hidden");
    return;
  }

  const panel = document.createElement("div");
  panel.className = `resources-panel${resourcesExpanded ? "" : " collapsed"}`;

  const header = document.createElement("button");
  header.type = "button";
  header.className = "resources-toggle";
  const title = document.createElement("span");
  title.className = "resources-title";
  title.textContent = t.resourcesLoaded;
  const counts = document.createElement("span");
  counts.className = "resources-counts";
  counts.textContent = sections.map((section) => `${section.name} ${section.items.length}`).join(" · ");
  const chevron = document.createElement("span");
  chevron.className = "resources-chevron";
  chevron.innerHTML = CHEVRON_ICON;
  header.append(title, counts, chevron);
  header.addEventListener("click", () => {
    resourcesExpanded = !resourcesExpanded;
    panel.classList.toggle("collapsed", !resourcesExpanded);
  });
  panel.appendChild(header);

  const bodyEl = document.createElement("div");
  bodyEl.className = "resources-body";
  for (const section of sections) {
    const block = document.createElement("div");
    block.className = "resource-section collapsed";

    const sectionHeader = document.createElement("button");
    sectionHeader.type = "button";
    sectionHeader.className = "resource-header";
    const name = document.createElement("span");
    name.className = "resource-name";
    name.textContent = `[${section.name}]`;
    const summary = document.createElement("span");
    summary.className = "resource-summary";
    summary.textContent = section.items.join(", ");
    const sectionChevron = document.createElement("span");
    sectionChevron.className = "resource-chevron";
    sectionChevron.innerHTML = CHEVRON_ICON;
    sectionHeader.append(name, summary, sectionChevron);

    const details = document.createElement("div");
    details.className = "resource-details";
    for (const path of section.details) {
      // Rows that are plain paths open in the editor; error rows ("path: msg") stay text.
      const openable = !path.includes(": ");
      if (openable) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "resource-file";
        row.textContent = path;
        row.title = t.resourceOpenTitle;
        row.addEventListener("click", () => post({ type: "openFile", path }));
        details.appendChild(row);
      } else {
        const row = document.createElement("div");
        row.textContent = path;
        details.appendChild(row);
      }
    }

    sectionHeader.addEventListener("click", () => block.classList.toggle("collapsed"));
    block.append(sectionHeader, details);
    bodyEl.appendChild(block);
  }
  panel.appendChild(bodyEl);
  resourcesEl.appendChild(panel);

  if (!state.needsAuth && sessionsEl.classList.contains("hidden")) resourcesEl.classList.remove("hidden");
}

/* ---------------------------------------------------------------- */
/* Sessions page                                                     */
/* ---------------------------------------------------------------- */

/** The sessions page replaces the chat: hide messages, composer and Tree. */
function openSessions(): void {
  sessionsEl.classList.remove("hidden");
  messagesEl.classList.add("hidden");
  composerEl.classList.add("hidden");
  resourcesEl.classList.add("hidden");
  delegationBarEl.classList.add("hidden");
  treeBtn.classList.add("hidden");
  post({ type: "listSessions" });
}

function closeSessions(): void {
  sessionsEl.classList.add("hidden");
  if (state.needsAuth) {
    applyAuthGate();
    return;
  }
  messagesEl.classList.remove("hidden");
  composerEl.classList.remove("hidden");
  resourcesEl.classList.toggle("hidden", !resourcesEl.hasChildNodes());
  delegationBarEl.classList.toggle("hidden", !state.delegation);
  treeBtn.classList.toggle("hidden", (state.messageCount ?? 0) === 0 || state.isStreaming || Boolean(state.delegation));
}

function renderSessions(items: SessionListItem[]): void {
  if (sessionsEl.classList.contains("hidden")) return;
  sessionsEl.replaceChildren();

  const header = document.createElement("div");
  header.className = "sessions-header";
  const title = document.createElement("span");
  title.textContent = t.sessionsHeader;
  const close = document.createElement("button");
  close.className = "secondary";
  close.textContent = t.sessionsClose;
  close.addEventListener("click", closeSessions);
  header.append(title, close);
  sessionsEl.appendChild(header);

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sessions-empty";
    empty.textContent = t.sessionsEmpty;
    sessionsEl.appendChild(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement("div");
    row.className = `session-row${item.current ? " current" : ""}${item.delegationRole ? ` delegation-${item.delegationRole}` : ""}`;
    row.title = item.file;

    const main = document.createElement("button");
    main.className = "session-main";
    main.title = t.sessionResumeTitle;

    const titleEl = document.createElement("span");
    titleEl.className = "session-title";
    titleEl.textContent = truncate(item.title, 120);

    const meta = document.createElement("span");
    meta.className = "session-meta";
    meta.textContent = item.timestamp?.slice(0, 16).replace("T", " ") ?? "";
    main.append(titleEl, meta);
    main.addEventListener("click", () => {
      if (item.delegationRole) {
        post({ type: "showDelegationSession", target: item.delegationRole });
        closeSessions();
        return;
      }
      if (!item.current) {
        // A running task line only permits viewing its parent/child pair.
        if (state.isStreaming || state.delegation) {
          appendNoticeCard("error", t.singleSessionHint);
          closeSessions();
          return;
        }
        clearFileRefs();
        post({ type: "resumeSession", file: item.file });
      }
      closeSessions();
    });
    row.appendChild(main);

    if (item.current || item.delegationRole) {
      const badge = document.createElement("span");
      badge.className = "session-badge";
      if (item.delegationRole === "child") {
        const spinner = document.createElement("span");
        spinner.className = "working-spinner";
        spinner.textContent = SPINNER_FRAMES[spinnerIndex]!;
        badge.append(spinner, document.createTextNode(` ${t.sessionSubagentRunning}`));
      } else if (item.delegationRole === "parent") {
        badge.textContent = t.sessionParentWaiting;
      } else if (state.isStreaming) {
        // Same braille spinner as the bottom "Working..." indicator.
        const spinner = document.createElement("span");
        spinner.className = "working-spinner";
        spinner.textContent = SPINNER_FRAMES[spinnerIndex]!;
        badge.append(spinner, document.createTextNode(` ${t.sessionCurrent}`));
      } else {
        badge.textContent = t.sessionCurrent;
      }
      row.appendChild(badge);
    } else {
      const del = document.createElement("button");
      del.className = "session-delete";
      del.textContent = t.sessionDelete;
      del.title = t.sessionDeleteTitle;
      del.addEventListener("click", (event) => {
        event.stopPropagation();
        post({ type: "deleteSession", file: item.file });
      });
      row.appendChild(del);
    }

    sessionsEl.appendChild(row);
  }
}

function clearMessages(): void {
  messagesEl.innerHTML = "";
  toolCards.clear();
  pendingUserBubbles.length = 0;
  assistantBubble = undefined;
  thinkingCard = undefined;
}

function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  try {
    return truncate(typeof args === "string" ? args : JSON.stringify(args), 300);
  } catch {
    return "";
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n... (${text.length - max} more chars)` : text;
}

function scrollToEnd(): void {
  // Queued/steering bubbles stay glued to the bottom (above the working
  // indicator) until they are consumed by the agent loop.
  for (const pending of pendingUserBubbles) {
    if (pending.element !== messagesEl.lastElementChild) messagesEl.appendChild(pending.element);
  }
  // Keep the working indicator glued to the bottom as new content arrives.
  if (workingEl && workingEl !== messagesEl.lastElementChild) messagesEl.appendChild(workingEl);
  // Respect the user's reading position: only auto-scroll while following.
  if (followBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  else updateScrollDownButton(true);
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
}
