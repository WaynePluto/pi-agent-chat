import { MAX_FILE_REFERENCES, MAX_IMAGE_ATTACHMENTS, type ChatEvent, type ProjectFileItem, type SlashCommand, type TranscriptImage } from "../shared/protocol.js";
import { button, el } from "./dom.js";
import { MAX_COMMAND_MATCHES } from "./format.js";
import { post } from "./host.js";
import { getDict } from "./i18n.js";
import { autocompleteEl, fileRefsEl, inputEl, resizeHandleEl } from "./shell.js";
import { state } from "./store.js";
import { followLatest } from "./transcript.js";

/**
 * The composer: text input, send / steer / follow-up, the `/` command
 * autocomplete and the `@` project-file picker with its reference chips.
 *
 * Everything the composer needs from the rest of the app is passed in through
 * `initComposer()`, so this module never reaches back into the page layout.
 */

const t = getDict();

const FILE_QUERY_DEBOUNCE_MS = 80;
const AUTOCOMPLETE_BLUR_DELAY_MS = 120;
const MIN_INPUT_HEIGHT_PX = 48;
/** Keep this drag limit aligned with textarea's CSS max-height. */
const MAX_INPUT_HEIGHT_PX = 320;
const MAX_INPUT_HEIGHT_RATIO = 0.3;

/** `/` autocomplete state: full catalogue, current matches and selection. */
let slashCommands: SlashCommand[] = [];
let matches: SlashCommand[] = [];
let selectedIndex = 0;

/* `@` project-file picker state. */
let acMode: "slash" | "file" = "slash";
let fileMatches: ProjectFileItem[] = [];
let fileIncludeIgnored = false;
let fileRequestId = 0;
let fileQueryTimer: number | undefined;
/** Selected references shown as removable chips above the input. */
const fileRefs: ProjectFileItem[] = [];

/**
 * Images pasted or dropped into the composer, in the order they will be sent.
 *
 * Only ids and thumbnails live here: the host holds the actual attachment and
 * hands back the processed image, so the composer never has to know how a
 * screenshot becomes something a model can read.
 */
interface ImageAttachment {
  id: string;
  image: TranscriptImage;
  note?: string;
}
const imageAttachments: ImageAttachment[] = [];
/** Placeholder chips for attachments still being processed by the host. */
let pendingAttachments = 0;
let attachmentRequestId = 0;

interface ComposerHooks {
  /** Called just before a prompt is posted (used to leave the sessions page). */
  beforeSend(): void;
}

let hooks: ComposerHooks = { beforeSend: () => {} };

export function initComposer(composerHooks: ComposerHooks): void {
  hooks = composerHooks;

  inputEl.addEventListener("keydown", onKeyDown);
  inputEl.addEventListener("input", () => updateAutocomplete());
  inputEl.addEventListener("blur", () => window.setTimeout(closeAutocomplete, AUTOCOMPLETE_BLUR_DELAY_MS));
  inputEl.addEventListener("paste", onPaste);

  /* Composer resize: drag the top edge up/down instead of a corner grip. */
  resizeHandleEl.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    resizeHandleEl.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = inputEl.offsetHeight;
    const onMove = (move: PointerEvent) => {
      const height = Math.min(
        Math.max(startHeight + (startY - move.clientY), MIN_INPUT_HEIGHT_PX),
        Math.min(window.innerHeight * MAX_INPUT_HEIGHT_RATIO, MAX_INPUT_HEIGHT_PX),
      );
      inputEl.style.height = `${height}px`;
    };
    const onUp = () => {
      resizeHandleEl.removeEventListener("pointermove", onMove);
      resizeHandleEl.removeEventListener("pointerup", onUp);
    };
    resizeHandleEl.addEventListener("pointermove", onMove);
    resizeHandleEl.addEventListener("pointerup", onUp);
  });
}

export function setSlashCommands(items: SlashCommand[]): void {
  slashCommands = items;
}

export function send(streamingBehavior?: "steer" | "followUp"): void {
  if (state.inputDisabled) return;
  const text = inputEl.value.trim();
  const references = fileRefs.map((item) => item.path);
  const imageIds = imageAttachments.map((item) => item.id);
  if (!text && references.length === 0 && imageIds.length === 0) return;
  // Images are deliberately left out of the ↑/↓ ring: an entry recalls what to
  // say again, while an attachment is consumed by the message it went with.
  pushInputHistory({ text, references: fileRefs.map((item) => ({ ...item })) });
  inputEl.value = "";
  fileRefs.length = 0;
  imageAttachments.length = 0;
  renderFileRefs();
  closeAutocomplete();
  hooks.beforeSend();
  followLatest();
  post({
    type: "prompt",
    text,
    references: references.length ? references : undefined,
    imageIds: imageIds.length ? imageIds : undefined,
    streamingBehavior,
  });
}

/* ---------------------------------------------------------------- */
/* Image attachments                                                 */
/* ---------------------------------------------------------------- */

/**
 * Paste handler — the only way images get in.
 *
 * Drag & drop is not offered, and cannot be: VS Code's workbench sets
 * `pointer-events: none` on every webview iframe as soon as a drag starts in
 * the window (`_startBlockingIframeDragEvents`, reached both from its own
 * `dragstart` listener and from the webview host page's file-drag detection),
 * so a webview never receives `dragover` or `drop` at all. Screenshots and
 * files copied in the OS file manager both arrive through the clipboard, which
 * does work.
 *
 * Only takes over when the clipboard actually carries an image; normal text
 * pastes must keep their default behaviour.
 */
function onPaste(event: ClipboardEvent): void {
  if (state.inputDisabled) return;
  const files = imageFilesOf(event.clipboardData);
  if (files.length === 0) return;
  event.preventDefault();
  for (const file of files) void attachFile(file);
}

function imageFilesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files ?? []).filter((file) => file.type.startsWith("image/"));
}

async function attachFile(file: File): Promise<void> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  // btoa() takes a binary string; chunked so a large screenshot cannot blow the
  // argument limit of String.fromCharCode.
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  requestAttachment({ name: file.name, mimeType: file.type, data: btoa(binary) });
}

function requestAttachment(request: { name?: string; mimeType?: string; data?: string }): void {
  if (imageAttachments.length + pendingAttachments >= MAX_IMAGE_ATTACHMENTS) return;
  pendingAttachments += 1;
  renderFileRefs();
  post({ type: "attachImage", requestId: ++attachmentRequestId, ...request });
}

/** Host answer to one `attachImage`: a processed image, or a refusal. */
export function onAttachment(id: string | undefined, image?: TranscriptImage, note?: string, error?: string): void {
  pendingAttachments = Math.max(0, pendingAttachments - 1);
  if (error !== undefined || !id || !image) {
    attachmentError = error;
    renderFileRefs();
    return;
  }
  attachmentError = undefined;
  imageAttachments.push({ id, image, note });
  renderFileRefs();
}

/** Last refusal, shown until the next attachment attempt succeeds. */
let attachmentError: string | undefined;

/** Replace the composer content, e.g. after forking away from a user message. */
export function setInput(text: string): void {
  // A programmatic replacement ends any history navigation: whatever is on
  // screen now is the new live composition.
  historyIndex = undefined;
  draft = { text: "", references: [] };
  inputEl.value = text;
  closeAutocomplete();
  inputEl.focus();
  inputEl.setSelectionRange(text.length, text.length);
}

/**
 * Transcripts already fed into the history, by id. A live transcript is posted
 * twice at window start (attach, then `ready`) and re-posted on every lane or
 * preview round trip; without this memory each re-post would stack another
 * copy of the same messages — consecutive-dedup only guards adjacent
 * duplicates, so the copies would interleave. A reloaded webview starts with
 * an empty set and an empty history, and populates once again, which is
 * exactly what `ready` re-flagging is for.
 */
const populatedTranscripts = new Set<string>();
const POPULATED_TRANSCRIPT_LIMIT = 16;

/**
 * Feed a replayed transcript's user messages into the ↑/↓ history, the way
 * the CLI's initial render does (`populateHistory: true`). Called only for
 * replays the host marked `populateInputHistory` — a session becoming the
 * live one — so lane tasks (written by the parent agent) never land here.
 *
 * The texts are what the session file holds: prompt templates expanded,
 * `/skill:` invocations collapsed back to their command form. The original
 * keystrokes only exist for prompts sent in this window, which the send path
 * records itself; the two sources share one ring, as in the CLI.
 */
export function populateInputHistoryFromEvents(transcriptId: string | undefined, events: ChatEvent[]): void {
  const key = transcriptId ?? "";
  if (populatedTranscripts.has(key)) return;
  populatedTranscripts.delete(key);
  populatedTranscripts.add(key);
  for (const oldest of populatedTranscripts) {
    if (populatedTranscripts.size <= POPULATED_TRANSCRIPT_LIMIT) break;
    populatedTranscripts.delete(oldest);
  }
  for (const event of events) {
    if (event.kind !== "user_message") continue;
    pushInputHistory({ text: event.text, references: [] });
  }
}

export function clearFileRefs(): void {
  fileRefs.length = 0;
  imageAttachments.length = 0;
  attachmentError = undefined;
  renderFileRefs();
}

function onKeyDown(event: KeyboardEvent): void {
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
  // Shell-style input history. The arrows are claimed on the outer lines of
  // the text: on the first line ↑ has no line above it and on the last line ↓
  // has none below, so a single-line composer behaves exactly like readline —
  // every ↑ one entry back, every ↓ one forward. Deeper inside a multi-line
  // draft the arrows keep moving the caret, so editing is never hijacked.
  // Never during IME composition: the arrows belong to the candidate window.
  if (
    (event.key === "ArrowUp" || event.key === "ArrowDown") &&
    !event.isComposing &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    const caret = inputEl.selectionStart;
    if (caret !== null && caret === inputEl.selectionEnd) {
      const onFirstLine = !inputEl.value.slice(0, caret).includes("\n");
      const onLastLine = !inputEl.value.slice(caret).includes("\n");
      if (event.key === "ArrowUp" && onFirstLine) {
        event.preventDefault();
        navigateInputHistory(-1);
      } else if (event.key === "ArrowDown" && onLastLine) {
        event.preventDefault();
        navigateInputHistory(1);
      }
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
      send(state.isStreaming || state.isCompacting ? "followUp" : undefined);
    }
  }
}

/* ---------------------------------------------------------------- */
/* Input history                                                     */
/* ---------------------------------------------------------------- */

/** One previously sent prompt: the text as typed plus its `@` references. */
interface InputHistoryEntry {
  text: string;
  references: ProjectFileItem[];
}

/** Ring size; the oldest entry is dropped, at a shell's scale. */
const INPUT_HISTORY_LIMIT = 100;

/**
 * Sent prompts of this window, newest last. Kept webview-side because the
 * history must hold what the user typed, not the expanded text a session
 * file stores (`/skill:` invocations, prompt templates). Shared by every
 * session — ↑/↓ is shell muscle memory, and a per-session ring would make
 * the keys feel broken right after switching. In memory only, the same
 * lifetime a shell gives its history.
 */
const inputHistory: InputHistoryEntry[] = [];
/** Position while navigating; undefined means live composition (the draft). */
let historyIndex: number | undefined;
/** What the composer held when navigation started, restored on the way down. */
let draft: InputHistoryEntry = { text: "", references: [] };

/**
 * Record a sent prompt and end any navigation. Consecutive duplicates are
 * skipped (bash `ignoredups`): re-sending the same line must not fill the
 * ring with copies of itself.
 */
function pushInputHistory(entry: InputHistoryEntry): void {
  const last = inputHistory[inputHistory.length - 1];
  if (!last || last.text !== entry.text || !sameReferences(last.references, entry.references)) {
    inputHistory.push(entry);
    if (inputHistory.length > INPUT_HISTORY_LIMIT) inputHistory.shift();
  }
  historyIndex = undefined;
  draft = { text: "", references: [] };
}

function sameReferences(a: ProjectFileItem[], b: ProjectFileItem[]): boolean {
  return a.length === b.length && a.every((item, index) => item.path === b[index]?.path);
}

/**
 * ↑/↓ through the history. Leaving a position writes the composer back to
 * it first, so an edit made to a recalled prompt survives the round trip —
 * readline does the same. An emptied composer is not written back: clearing
 * a recalled line reads as "discard", and the original is the friendlier
 * thing to find on the way back.
 */
function navigateInputHistory(direction: -1 | 1): void {
  if (historyIndex === undefined) {
    if (direction >= 0 || inputHistory.length === 0) return;
    draft = composerEntry();
    historyIndex = inputHistory.length - 1;
    fillComposer(inputHistory[historyIndex]!);
    return;
  }
  const current = composerEntry();
  if (current.text.trim() || current.references.length > 0) inputHistory[historyIndex] = current;
  const next = historyIndex + direction;
  if (next < 0) return; // At the oldest entry: stay there, no wrap-around.
  if (next >= inputHistory.length) {
    // Past the newest entry: back to live composition, the draft returns.
    historyIndex = undefined;
    fillComposer(draft);
    return;
  }
  historyIndex = next;
  fillComposer(inputHistory[next]!);
}

/** Snapshot of the composer as a history entry. */
function composerEntry(): InputHistoryEntry {
  return { text: inputEl.value, references: fileRefs.map((item) => ({ ...item })) };
}

/** Replace the composer with a history entry; the caret lands at the end. */
function fillComposer(entry: InputHistoryEntry): void {
  inputEl.value = entry.text;
  fileRefs.length = 0;
  fileRefs.push(...entry.references.map((item) => ({ ...item })));
  renderFileRefs();
  closeAutocomplete();
  inputEl.setSelectionRange(entry.text.length, entry.text.length);
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
  return [...starts, ...contains].slice(0, MAX_COMMAND_MATCHES);
}

function renderAutocomplete(): void {
  autocompleteEl.replaceChildren();
  matches.forEach((command, index) => {
    const row = el("div", `autocomplete-row${index === selectedIndex ? " selected" : ""}`);
    row.append(
      el("span", "autocomplete-name", `/${command.name}`),
      el("span", `autocomplete-kind ${command.kind}`, command.kind),
      el("span", "autocomplete-description", [command.argumentHint, command.description].filter(Boolean).join("  ")),
    );
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
  }, FILE_QUERY_DEBOUNCE_MS);
}

function requestFileMatches(): void {
  const prefix = currentFilePrefix();
  if (prefix === undefined) return;
  post({ type: "listProjectFiles", requestId: ++fileRequestId, query: prefix, includeIgnored: fileIncludeIgnored });
}

export function onProjectFiles(requestId: number, items: ProjectFileItem[], error?: string): void {
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
  autocompleteEl.appendChild(
    el("div", "autocomplete-hint", fileIncludeIgnored ? t.fileHintIgnoredShown : t.fileHintIgnoredHidden),
  );

  fileMatches.forEach((item, index) => {
    const row = el("div", `autocomplete-row${index === selectedIndex ? " selected" : ""}`);
    row.appendChild(el("span", "autocomplete-name", item.path));
    if (item.ignored) row.appendChild(el("span", "autocomplete-kind", t.fileIgnoredBadge));
    if (item.sensitive) row.appendChild(el("span", "autocomplete-kind sensitive", t.fileSensitiveBadge));
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
  if (fileRefs.length >= MAX_FILE_REFERENCES) {
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

function renderFileRefs(): void {
  fileRefsEl.replaceChildren();
  const empty = fileRefs.length === 0 && imageAttachments.length === 0 && pendingAttachments === 0 && !attachmentError;
  fileRefsEl.classList.toggle("hidden", empty);
  for (const item of fileRefs) {
    const chip = el("span", `file-ref-chip${item.ignored ? " ignored" : ""}${item.sensitive ? " sensitive" : ""}`);
    chip.title = [item.path, item.ignored ? t.fileIgnoredBadge : "", item.sensitive ? t.fileSensitiveBadge : ""]
      .filter(Boolean)
      .join(" · ");

    const remove = button("file-ref-remove", "×", () => {
      const index = fileRefs.indexOf(item);
      if (index !== -1) fileRefs.splice(index, 1);
      renderFileRefs();
      inputEl.focus();
    });
    remove.title = t.fileRemoveTitle;

    chip.append(el("span", "file-ref-label", `@${item.path}`), remove);
    fileRefsEl.appendChild(chip);
  }

  for (const attachment of imageAttachments) {
    // The chip shows the processed bytes, so what the user sees here is what
    // the model gets — including a downscale that already happened.
    const chip = el("span", `file-ref-chip image${attachment.note ? " warned" : ""}`);
    chip.title = [attachment.image.name, attachment.note].filter(Boolean).join(" · ");
    const thumb = document.createElement("img");
    thumb.className = "file-ref-thumb";
    thumb.src = `data:${attachment.image.mimeType};base64,${attachment.image.data}`;
    thumb.alt = attachment.image.name ?? "";
    const remove = button("file-ref-remove", "×", () => {
      const index = imageAttachments.indexOf(attachment);
      if (index !== -1) imageAttachments.splice(index, 1);
      post({ type: "detachImage", id: attachment.id });
      renderFileRefs();
      inputEl.focus();
    });
    remove.title = t.fileRemoveTitle;
    chip.append(thumb, el("span", "file-ref-label", attachment.image.name ?? t.imageAttachmentLabel), remove);
    fileRefsEl.appendChild(chip);
  }

  for (let i = 0; i < pendingAttachments; i += 1) {
    fileRefsEl.appendChild(el("span", "file-ref-chip image pending", t.imageAttaching));
  }

  // A refusal has to be visible: the image simply not appearing would read as
  // the paste having been ignored.
  if (attachmentError) fileRefsEl.appendChild(el("span", "file-ref-error", attachmentError));

  // One shared note for the whole strip: it describes the session (no vision
  // support, images blocked in settings), not an individual attachment.
  const note = imageAttachments.find((item) => item.note)?.note;
  if (note) fileRefsEl.appendChild(el("span", "file-ref-note", note));
}
