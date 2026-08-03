import type { ChatEvent } from "../shared/protocol.js";
import { CARD_CLASSES, WORK_CLASSES, createCollapsible, type Collapsible } from "./collapsible.js";
import { button, el } from "./dom.js";
import {
  MAX_DIFF_LINES,
  MAX_NOTICE_HEADER_CHARS,
  MAX_TOOL_ARGS_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  truncate,
} from "./format.js";
import { post } from "./host.js";
import { getDict } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";
import { messagesEl, scrollDownBtn } from "./shell.js";
import { spinner } from "./spinner.js";
import { state } from "./store.js";

/**
 * The transcript: chat bubbles, the grouped "work block" of non-formal output
 * (thinking + tool cards), status/error notices and the working indicator.
 *
 * Live streaming and history replay share one path (`applyEvent`), so a resumed
 * session renders exactly like a live one.
 */

const t = getDict();

/** Streaming assistant bubble keeps raw markdown for re-render on each delta. */
interface StreamingBubble {
  element: HTMLElement;
  raw: string;
}
let assistantBubble: StreamingBubble | undefined;

/** Queued/steering bubbles waiting to be consumed by the agent loop. */
const pendingUserBubbles: Array<{ element: HTMLElement; text: string; mode: "steer" | "followUp" }> = [];

interface ThinkingCard extends Collapsible {
  raw: string;
}
let thinkingCard: ThinkingCard | undefined;

interface WorkBlock {
  collapsible: Collapsible;
  thinkingCount: number;
  toolCount: number;
  failedToolCount: number;
  activeTools: Map<string, string>;
  action?: string;
}
/** The non-formal output group currently being built by the agent. */
let activeWorkBlock: WorkBlock | undefined;

interface ToolCard extends Collapsible {
  argsText: string;
  bodyText: string;
  patch?: string;
  path?: string;
}
const toolCards = new Map<string, ToolCard>();

let renderScheduled = false;

/** Working indicator row shown at the end of the message list while streaming. */
let workingEl: HTMLElement | undefined;
let workingLabelEl: HTMLElement | undefined;

/* ---------------------------------------------------------------- */
/* Sticky auto-scroll                                                */
/* ---------------------------------------------------------------- */

/** Only follow new content while the user is at (or near) the bottom. */
let followBottom = true;

const NEAR_BOTTOM_PX = 40;

function isNearBottom(): boolean {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < NEAR_BOTTOM_PX;
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

/** Re-attach to the bottom, e.g. after the user sends a new message. */
export function followLatest(): void {
  followBottom = true;
  updateScrollDownButton(false);
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

/* ---------------------------------------------------------------- */
/* Event rendering                                                   */
/* ---------------------------------------------------------------- */

export function applyEvent(event: ChatEvent): void {
  switch (event.kind) {
    case "user_message":
      appendUserBubble(event.text, event.mode);
      break;
    case "assistant_start":
      assistantBubble = undefined;
      finishThinkingCard();
      break;
    case "text_delta":
      // Formal assistant text ends the current non-formal work block. Any
      // later thinking/tools will start a fresh block in the transcript.
      finishThinkingCard();
      finishWorkBlock();
      assistantBubble ??= createStreamingBubble("assistant");
      assistantBubble.raw += event.delta;
      scheduleRender();
      break;
    case "thinking_delta":
      thinkingCard ??= createThinkingCard(true);
      thinkingCard.raw += event.delta;
      thinkingCard.invalidate();
      scheduleRender();
      break;
    case "thinking_message": {
      const card = createThinkingCard(false);
      card.raw = event.text;
      card.invalidate();
      finishCard(card);
      thinkingCard = undefined;
      break;
    }
    case "assistant_message":
      finishWorkBlock();
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
        card.invalidate();
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
      // This only ends one low-level run. Automatic retries, compaction and
      // queued continuations may still add cards to the same work block.
      assistantBubble = undefined;
      break;
    case "agent_settled":
      flushStreaming();
      finishThinkingCard();
      finishWorkBlock();
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

export function applyHistory(events: ChatEvent[]): void {
  clearMessages();
  followBottom = true;
  for (const event of events) applyEvent(event);
  if (events.length === 0) appendBubble("status", t.emptySession).classList.add("empty-session");
  // Persisted history has no agent lifecycle events. Its final non-formal
  // cards belong to a completed historical execution process, not a live one.
  finishWorkBlock();
  scrollToEnd();
}

export function clearMessages(): void {
  messagesEl.innerHTML = "";
  toolCards.clear();
  pendingUserBubbles.length = 0;
  assistantBubble = undefined;
  thinkingCard = undefined;
  activeWorkBlock = undefined;
}

/* ---------------------------------------------------------------- */
/* Bubbles                                                           */
/* ---------------------------------------------------------------- */

function appendBubble(role: string, text: string): HTMLElement {
  const wrapper = el("div", `bubble ${role}`, text);
  messagesEl.appendChild(wrapper);
  return wrapper;
}

function appendMarkdownBubble(role: string, text: string): HTMLElement {
  const wrapper = el("div", `bubble markdown ${role}`);
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
  wrapper.prepend(el("span", "bubble-badge", mode === "steer" ? t.steerBadge : t.queuedBadge));
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
  const element = el("div", `bubble markdown ${role}`);
  messagesEl.appendChild(element);
  return { element, raw: "" };
}

/**
 * Status / error notices (retry, compaction, command feedback) render as
 * collapsed one-line cards; expanding shows the full text.
 */
export function appendNoticeCard(kind: "status" | "error", text: string): void {
  const work = ensureWorkBlock();
  const firstLine = text.split("\n")[0] ?? "";
  const short = firstLine.length > MAX_NOTICE_HEADER_CHARS ? `${firstLine.slice(0, MAX_NOTICE_HEADER_CHARS)}...` : firstLine;
  // Nothing hidden behind the fold: render a flat, non-expandable card.
  if (short === text) {
    const card = el("div", `notice-card flat ${kind}`);
    card.appendChild(el("span", "card-label", text));
    work.collapsible.body.appendChild(card);
    return;
  }
  createCollapsible({
    classes: CARD_CLASSES,
    rootClass: `notice-card ${kind}`,
    label: short,
    parent: work.collapsible.body,
    render: (body) => body.replaceChildren(el("pre", "notice-body", text)),
  });
}

/* ---------------------------------------------------------------- */
/* Work block + collapsible cards (thinking, tools)                  */
/* ---------------------------------------------------------------- */

/**
 * Create or reuse the current group of non-formal output. The group is kept
 * at the top level of the transcript while its cards live in `body`.
 */
function ensureWorkBlock(): WorkBlock {
  if (activeWorkBlock) return activeWorkBlock;

  const work: WorkBlock = {
    collapsible: createCollapsible({
      classes: WORK_CLASSES,
      rootClass: "work-block running",
      tag: "section",
      label: t.workHeader,
      parent: messagesEl,
    }),
    thinkingCount: 0,
    toolCount: 0,
    failedToolCount: 0,
    activeTools: new Map(),
  };
  updateWorkStatus(work);
  activeWorkBlock = work;
  return work;
}

/** Update the compact execution summary shown while the work block is collapsed. */
function updateWorkStatus(work: WorkBlock, action?: string): void {
  if (action !== undefined) work.action = action;
  work.collapsible.statusEl.textContent = t.workInProgress(work.thinkingCount, work.toolCount, work.action);
}

/** Mark the current group complete; the next non-formal event creates a new one. */
function finishWorkBlock(): void {
  if (!activeWorkBlock) return;
  activeWorkBlock.collapsible.root.classList.remove("running");
  activeWorkBlock.collapsible.root.classList.add("finished");
  activeWorkBlock.collapsible.statusEl.textContent = t.workDone(
    activeWorkBlock.thinkingCount,
    activeWorkBlock.toolCount,
    activeWorkBlock.failedToolCount,
  );
  activeWorkBlock = undefined;
}

function createThinkingCard(streaming: boolean): ThinkingCard {
  const work = ensureWorkBlock();
  work.thinkingCount += 1;
  updateWorkStatus(work, t.workThinking);
  const entry = createCollapsible({
    classes: CARD_CLASSES,
    rootClass: "thinking-card",
    label: streaming ? t.thinkingHeader : t.thinkingDone,
    parent: work.collapsible.body,
    render: (body) => body.replaceChildren(renderMarkdown(entry.raw)),
  }) as ThinkingCard;
  entry.raw = "";
  if (streaming) entry.root.classList.add("streaming");
  return entry;
}

/** Freeze the active thinking card: stop the pulse and relabel it. */
function finishThinkingCard(): void {
  if (!thinkingCard) return;
  finishCard(thinkingCard);
  thinkingCard = undefined;
}

function finishCard(card: ThinkingCard): void {
  card.root.classList.remove("streaming");
  card.labelEl.textContent = t.thinkingDone;
  card.invalidate();
  card.refresh();
}

function startToolCard(id: string, name: string, args: unknown): void {
  const work = ensureWorkBlock();
  work.toolCount += 1;
  work.activeTools.set(id, name);
  updateWorkStatus(work, t.workCalling(name));
  const entry = createCollapsible({
    classes: CARD_CLASSES,
    rootClass: "tool-card",
    label: name,
    status: t.running,
    parent: work.collapsible.body,
    render: (body) => renderToolBody(toolCards.get(id) ?? entry, body),
  }) as ToolCard;
  entry.root.classList.add("running", "streaming");
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
  entry.root.classList.remove("running", "streaming");
  entry.root.classList.toggle("error", event.isError);
  entry.bodyText = event.text;
  entry.patch = event.patch;
  entry.path = event.path;
  entry.invalidate();
  entry.refresh();

  const work = activeWorkBlock;
  if (work) {
    work.activeTools.delete(event.id);
    if (event.isError) work.failedToolCount += 1;
    const activeTool = [...work.activeTools.values()].at(-1);
    updateWorkStatus(work, activeTool ? t.workCalling(activeTool) : t.workLastTool(event.name));
  }
  toolCards.delete(event.id);
}

/** Full body of a tool card: args summary + output text or diff + actions. */
function renderToolBody(entry: ToolCard, body: HTMLElement): void {
  body.replaceChildren();
  if (entry.argsText) body.appendChild(el("div", "tool-args", entry.argsText));
  if (entry.patch) {
    const diff = el("div");
    diff.appendChild(renderPatch(entry.patch));
    body.appendChild(diff);
    if (entry.path) {
      const actions = el("div", "tool-actions");
      actions.append(
        button("secondary", t.openDiff, () => post({ type: "openDiff", path: entry.path ?? "", patch: entry.patch ?? "" })),
        button("secondary", t.openFile, () => post({ type: "openFile", path: entry.path ?? "" })),
      );
      body.appendChild(actions);
    }
  } else if (entry.bodyText) {
    body.appendChild(el("pre", "tool-body", truncate(entry.bodyText, MAX_TOOL_OUTPUT_CHARS)));
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
  // Collapsed cards keep their raw text unrendered on purpose.
  if (thinkingCard) {
    thinkingCard.invalidate();
    thinkingCard.refresh();
  }
  for (const card of toolCards.values()) card.refresh();
}

/** Render a unified patch with per-line coloring, hiding the file headers. */
function renderPatch(patch: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = patch.split("\n").filter((line) => !/^(---|\+\+\+|diff |index )/.test(line));
  for (const line of lines.slice(0, MAX_DIFF_LINES)) {
    const row = el("div", "diff-line");
    if (line.startsWith("+")) row.classList.add("added");
    else if (line.startsWith("-")) row.classList.add("removed");
    else if (line.startsWith("@@")) row.classList.add("hunk");
    row.textContent = line || " ";
    fragment.appendChild(row);
  }
  if (lines.length > MAX_DIFF_LINES) {
    fragment.appendChild(el("div", "diff-line hunk", `... ${lines.length - MAX_DIFF_LINES} more lines`));
  }
  return fragment;
}

function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  try {
    return truncate(typeof args === "string" ? args : JSON.stringify(args), MAX_TOOL_ARGS_CHARS);
  } catch {
    return "";
  }
}

/* ---------------------------------------------------------------- */
/* Working indicator                                                 */
/* ---------------------------------------------------------------- */

/** CLI-style working row, specialized while a child session is active. */
export function updateWorkingIndicator(): void {
  if (state.isStreaming) {
    if (!workingEl) {
      workingEl = el("div", "working-row");
      workingLabelEl = el("span");
      workingEl.append(spinner(), workingLabelEl);
    }
    if (workingLabelEl) {
      workingLabelEl.textContent = state.delegation?.role === "parent"
        ? ` ${t.waitingForSubagent}`
        : state.delegation?.role === "child"
          ? ` ${t.subagentWorking}`
          : ` ${t.streaming}`;
    }
    messagesEl.appendChild(workingEl); // re-append to keep it last
    scrollToEnd();
  } else {
    workingEl?.remove();
    workingEl = undefined;
    workingLabelEl = undefined;
  }
}
