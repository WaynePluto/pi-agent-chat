import type { ChatEvent, JsonValue, RetryOfferState, SkillRef, SubagentSetup } from "../shared/protocol.js";
import { SUBAGENT_TOOL } from "../shared/protocol.js";
import { createMessageBubble, type MessageBubble } from "./bubble.js";
import { CARD_CLASSES, WORK_CLASSES, createCollapsible, type Collapsible } from "./collapsible.js";
import { button, el, icon } from "./dom.js";
import {
  MAX_DIFF_LINES,
  MAX_LANE_DETAIL_CHARS,
  MAX_NOTICE_HEADER_CHARS,
  MAX_TOOL_ARGS_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  formatTokens,
  truncate,
} from "./format.js";
import { post } from "./host.js";
import { BRANCH_ICON, RETRY_ICON, REWIND_ICON, TAG_ICON } from "./icons.js";
import { getDict } from "./i18n.js";
import { renderMarkdown } from "./markdown.js";
import { clearResourceHighlights, markExtensionUsed, markPromptUsed, markSkillActive, markToolUsed } from "./resources-view.js";
import { messagesEl, scrollDownBtn } from "./shell.js";
import { spinner } from "./spinner.js";
import { currentLane, isDelegating, state } from "./store.js";
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
  bubble: MessageBubble;
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
  /** Tool name, so cards with a purpose-built body can recognise themselves. */
  toolName: string;
  argsText: string;
  bodyText: string;
  patch?: string;
  path?: string;
  /** Tool-defined structured result; see `renderDetailsBlock`. */
  details?: JsonValue;
}
const toolCards = new Map<string, ToolCard>();

let renderScheduled = false;

/** Working indicator row shown at the end of the message list while streaming. */
let workingEl: HTMLElement | undefined;
let workingLabelEl: HTMLElement | undefined;
/**
 * Everything about how a transcript is being looked at, kept per transcript.
 *
 * Switching away and back rebuilds the DOM from scratch, so without this the
 * user loses their place every time they glance at a subagent — which this
 * feature invites them to do constantly. Bounded and in LRU order: view state
 * is not worth leaking a session's worth of memory over.
 */
interface TranscriptViewState {
  /** Per work block, by position: open, and how far into it the user had read. */
  work: Map<number, { expanded: boolean; scrollTop?: number }>;
  /**
   * Message bubbles the user folded or unfolded by hand, by position. Only
   * manual decisions are recorded: everything else follows the default rule
   * (newest of each role open), which is recomputed on every replay.
   */
  bubbles: Map<number, boolean>;
  /** Message list offset. Undefined means this transcript was never left. */
  scrollTop?: number;
  /** Whether the user was following new output when they left. */
  followBottom: boolean;
  /** Offsets inside tool card bodies, by tool call id. */
  toolScroll: Map<string, number>;
}

function emptyViewState(): TranscriptViewState {
  return { work: new Map(), bubbles: new Map(), followBottom: true, toolScroll: new Map() };
}

const transcriptViews = new Map<string, TranscriptViewState>();
const MAX_REMEMBERED_TRANSCRIPTS = 8;
let currentView: TranscriptViewState = emptyViewState();
/**
 * Work blocks of the transcript on screen, by position.
 *
 * Position is a stable identity: the same event sequence always groups into the
 * same blocks, whether replayed at once or appended live.
 */
const workBlocks = new Map<number, Collapsible>();
let workBlockIndex = -1;

/**
 * The newest formal message of each role, and how many have been rendered.
 *
 * The count is the bubble's position, the same stable identity work blocks use;
 * the newest bubble of a role is the one that stays unfolded until the next
 * message of that role takes its place.
 */
const latestBubbles = new Map<string, MessageBubble>();
let bubbleIndex = -1;

function selectTranscript(id: string | undefined): void {
  const key = id ?? "";
  const existing = transcriptViews.get(key);
  if (existing) {
    // Re-insert to refresh its LRU position.
    transcriptViews.delete(key);
    transcriptViews.set(key, existing);
    currentView = existing;
    return;
  }
  currentView = emptyViewState();
  transcriptViews.set(key, currentView);
  for (const oldest of transcriptViews.keys()) {
    if (transcriptViews.size <= MAX_REMEMBERED_TRANSCRIPTS) break;
    transcriptViews.delete(oldest);
  }
}

/**
 * Record where the user was, just before the DOM holding that information is
 * torn down. Called from `clearMessages()` because every teardown path goes
 * through it, and there it still sees the outgoing transcript.
 */
function captureViewState(): void {
  currentView.scrollTop = messagesEl.scrollTop;
  currentView.followBottom = followBottom;
  for (const [index, block] of workBlocks) {
    currentView.work.set(index, { expanded: block.expanded, scrollTop: block.body.scrollTop || undefined });
  }
  for (const [id, card] of toolCards) {
    const scroller = card.body.querySelector(".tool-body");
    if (scroller instanceof HTMLElement && scroller.scrollTop > 0) currentView.toolScroll.set(id, scroller.scrollTop);
  }
}

/** Put the reading position back, once the rebuilt transcript is in the DOM. */
function restoreViewState(): void {
  for (const [index, block] of workBlocks) {
    const saved = currentView.work.get(index)?.scrollTop;
    if (saved !== undefined) block.body.scrollTop = saved;
  }
  for (const [id, card] of toolCards) restoreToolScroll(id, card.body);
  const saved = currentView.scrollTop;
  if (saved === undefined) {
    // First visit to this transcript: show the newest content, as always.
    followBottom = true;
    scrollToEnd();
    return;
  }
  followBottom = currentView.followBottom;
  messagesEl.scrollTop = saved;
  // Markdown, code blocks and images can settle a frame later and shift the
  // content out from under the offset just applied.
  requestAnimationFrame(() => {
    if (currentView.scrollTop === saved) messagesEl.scrollTop = saved;
    updateScrollDownButton(false);
  });
}

/** Card bodies render lazily, so one expanded after the replay restores here. */
function restoreToolScroll(id: string, body: HTMLElement): void {
  const saved = currentView.toolScroll.get(id);
  if (saved === undefined) return;
  const scroller = body.querySelector(".tool-body");
  if (scroller instanceof HTMLElement) scroller.scrollTop = saved;
}

/* ---------------------------------------------------------------- */
/* Search support: reveal, and the text of unrendered bodies         */
/* ---------------------------------------------------------------- */

/**
 * How to open one collapsible thing on screen: expand a card or work block,
 * unfold a message bubble. Keyed by root element so transcript search can
 * reach them from a bare DOM anchor.
 */
const revealActions = new WeakMap<HTMLElement, () => HTMLElement | undefined>();

/** Register how a collapsible opens itself; returns its body on reveal. */
function registerReveal(collapsible: Collapsible): void {
  revealActions.set(collapsible.root, () => {
    collapsible.setExpanded(true);
    return collapsible.body;
  });
}

/**
 * Expand everything between the transcript root and `target` — and `target`
 * itself when it is a collapsible — outermost first, so a match buried in a
 * collapsed execution is uncovered layer by layer: the work block, then the
 * card, and the details block inside it on the next navigation (its region
 * only exists once the card body has rendered). Returns the collapsible body
 * of `target` when `target` itself became one, else undefined.
 */
export function revealTranscriptElement(target: Element): HTMLElement | undefined {
  const chain: Array<() => HTMLElement | undefined> = [];
  for (let node: Element | null = target; node && node !== messagesEl; node = node.parentElement) {
    const action = revealActions.get(node as HTMLElement);
    if (action) chain.push(action);
  }
  let body: HTMLElement | undefined;
  // Outermost first: expanding a parent renders the DOM the children live in.
  for (const action of chain.reverse()) body = action() ?? body;
  return body;
}

interface HiddenBody {
  /** Collapsed body element; empty until the first expansion renders it. */
  body: HTMLElement;
  getText(): string;
}

/**
 * Text of lazy card bodies that have never rendered — tool output, thinking,
 * notices, compaction summaries, details payloads — so search can reach it
 * before any expansion. Collapsed is not enough to be listed: the body must
 * still be empty, because once rendered the text is in the DOM for good (and
 * re-collapsing keeps it there). Cleared with the transcript.
 */
const hiddenBodies = new Map<HTMLElement, HiddenBody>();

function registerHiddenBody(collapsible: Collapsible, getText: () => string): void {
  registerReveal(collapsible);
  hiddenBodies.set(collapsible.root, { body: collapsible.body, getText });
}

/** Searchable text of not-yet-rendered card bodies, with the card root to reveal. */
export function collectHiddenBodies(): Array<{ root: HTMLElement; text: string }> {
  const regions: Array<{ root: HTMLElement; text: string }> = [];
  for (const [root, region] of hiddenBodies) {
    if (!root.isConnected) {
      hiddenBodies.delete(root);
      continue;
    }
    // Rendered already: the DOM corpus covers this text from here on.
    if (region.body.childElementCount > 0) continue;
    const text = region.getText();
    if (text) regions.push({ root, text });
  }
  return regions;
}

/* ---------------------------------------------------------------- */
/* Batched history replay                                            */
/* ---------------------------------------------------------------- */

/**
 * Where top-level transcript nodes are appended. While replaying a persisted
 * session this is a detached fragment: building hundreds of cards directly in
 * the live DOM makes the browser maintain layout for every single append.
 */
let sink: HTMLElement | DocumentFragment = messagesEl;

/** Suppresses per-event scrolling (which forces a synchronous layout). */
let replaying = false;

/** The "no messages yet" / "loading" placeholder, tracked instead of queried. */
let placeholderEl: HTMLElement | undefined;
/** Last flags seen with a history, reused by the new-session placeholder. */
let systemPromptOverridden = false;
let subagent: SubagentSetup | undefined;

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
      // A user message ends the execution process that precedes it, exactly as
      // formal assistant text does — otherwise everything the agent does next
      // keeps landing in the block above the bubble. Queued/steering messages
      // are the exception: they are still floating at the bottom and the run on
      // screen is not theirs yet, so they split the transcript only once the
      // agent consumes them (see `reconcilePendingBubbles`).
      if (!event.mode) {
        finishThinkingCard();
        finishWorkBlock();
      }
      appendUserBubble(event.text, event.mode, event.skill, event.prompt, event.extension);
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
      startToolCard(event.id, event.name, event.args, event.skill);
      break;
    case "tool_update": {
      const card = toolCards.get(event.id);
      if (card) {
        if (event.text) card.bodyText = event.text;
        // Live payload of a still-running tool. The delegation card is built
        // from it, so this is what makes its per-subagent rows move.
        if (event.details !== undefined) card.details = event.details;
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
    case "compaction_boundary":
      flushStreaming();
      finishThinkingCard();
      finishWorkBlock();
      assistantBubble = undefined;
      appendCompactionBoundary(event.summary, event.tokensBefore, event.estimatedTokensAfter);
      break;
    case "status":
      appendNoticeCard("status", event.text, event.scope, event.retry);
      break;
    case "error":
      appendNoticeCard("error", event.text, event.scope);
      break;
  }
  if (placeholderEl) {
    placeholderEl.remove();
    placeholderEl = undefined;
  }
  // During replay every event would force a layout read; scroll once at the end.
  if (!replaying) scrollToEnd();
}

/**
 * Replay a persisted transcript. Everything is built inside a detached
 * fragment and attached in one go, so a long session costs one layout pass
 * instead of one per event.
 */
export function applyHistory(
  events: ChatEvent[],
  live = false,
  systemPromptOverriddenNow = false,
  subagentNow?: SubagentSetup,
  transcriptId?: string,
): void {
  const started = performance.now();
  systemPromptOverridden = systemPromptOverriddenNow;
  subagent = subagentNow;
  // Order matters: `clearMessages()` captures where the user was in the
  // transcript being replaced, so the switch to the new one comes after it.
  clearMessages();
  selectTranscript(transcriptId);
  const fragment = document.createDocumentFragment();
  sink = fragment;
  replaying = true;
  try {
    for (const event of events) applyEvent(event);
  } finally {
    replaying = false;
    sink = messagesEl;
  }
  const built = performance.now();
  messagesEl.appendChild(fragment);

  if (events.length === 0) appendEmptySessionPlaceholder();
  // Persisted history has no agent lifecycle events. Its final non-formal
  // cards belong to a completed historical execution process, not a live one —
  // unless the session is still streaming (e.g. returning from a preview),
  // where closing the block would split one execution process in two.
  if (!live) finishWorkBlock();
  restoreViewState();
  // One line per session switch: the cheapest way to spot replay regressions
  // on a real (large) session from the webview devtools. The transcript id and
  // restored-state count are here because view state surviving a round trip
  // (parent -> subagent -> parent) is invisible in the DOM until it breaks.
  console.log(
    `[pi-agent-chat] history replay: ${events.length} events, transcript ${transcriptId ?? "(none)"}, ${currentView.work.size} remembered work block(s), build ${Math.round(built - started)}ms, total ${Math.round(performance.now() - started)}ms`,
  );
}

/**
 * Placeholder shown between "user picked a session" and the history arriving:
 * without it the previous transcript stays on screen while the host loads and
 * parses the session file, which reads as a frozen UI.
 */
export function showLoading(): void {
  clearMessages();
  const row = el("div", "working-row");
  row.append(spinner(), el("span", undefined, ` ${t.loadingSession}`));
  messagesEl.appendChild(row);
  placeholderEl = row;
  followBottom = true;
}

/**
 * Placeholder for "start a new session": nothing has to be loaded, so the
 * spinner of `showLoading()` would only flash. Render the empty-session
 * message right away — the empty history that follows renders the same bubble,
 * so nothing changes on screen when it arrives.
 */
export function showNewSession(): void {
  clearMessages();
  appendEmptySessionPlaceholder();
  followBottom = true;
}

function appendEmptySessionPlaceholder(): void {
  placeholderEl = appendBubble("status", t.emptySession(systemPromptOverridden, subagent));
  placeholderEl.classList.add("empty-session");
}

export function clearMessages(): void {
  // Before the DOM goes: this is the last moment the reading position exists.
  captureViewState();
  messagesEl.innerHTML = "";
  toolCards.clear();
  pendingUserBubbles.length = 0;
  assistantBubble = undefined;
  thinkingCard = undefined;
  activeWorkBlock = undefined;
  // Blocks are numbered per rendered transcript; the state they index into is
  // only swapped when the transcript itself changes.
  workBlocks.clear();
  workBlockIndex = -1;
  latestBubbles.clear();
  bubbleIndex = -1;
  hiddenBodies.clear();
  placeholderEl = undefined;
  // Skill marks describe the displayed transcript, so they go with it.
  clearResourceHighlights();
}

/* ---------------------------------------------------------------- */
/* Bubbles                                                           */
/* ---------------------------------------------------------------- */

function appendBubble(role: string, text: string): HTMLElement {
  const wrapper = el("div", `bubble ${role}`, text);
  sink.appendChild(wrapper);
  return wrapper;
}

function appendMarkdownBubble(role: string, text: string): MessageBubble {
  const index = ++bubbleIndex;
  const remembered = currentView.bubbles.get(index);
  const bubble = createMessageBubble({
    role,
    text,
    folded: remembered,
    onToggle: (folded) => currentView.bubbles.set(index, folded),
  });
  // The message that just arrived is the one being read, so the previous one of
  // the same role folds away — unless the user opened or closed it by hand, in
  // which case their decision outranks the default.
  const previous = latestBubbles.get(role);
  if (previous && !previous.pinned) previous.setFolded(true);
  latestBubbles.set(role, bubble);
  // A folded bubble clips its content away, so search must be able to open it.
  // Not pinned: only the user's own toggle outranks the fold rules.
  revealActions.set(bubble.root, () => {
    if (bubble.folded) bubble.setFolded(false);
    return undefined;
  });
  sink.appendChild(bubble.root);
  return bubble;
}

/**
 * User message; queued (follow-up) and steering messages get a badge and a
 * distinct accent so they read differently from immediate prompts.
 */
function appendUserBubble(text: string, mode?: "steer" | "followUp", skill?: string, prompt?: string, extension?: string): void {
  const wrapper = appendMarkdownBubble("user", text).root;
  wrapper.appendChild(entryActionBar());
  // A prompt template is expanded, and an extension command is consumed, before
  // the agent runs, so neither leaves a tool card behind. The host resolves
  // them from the submitted text; light up their resource rows here, the way a
  // model-initiated load lights up a skill.
  if (prompt) markPromptUsed(prompt);
  if (extension) markExtensionUsed(extension);
  if (skill) {
    // `/skill:<name>` is expanded by the SDK before the agent runs, so no tool
    // card will ever report it; mark the bubble instead, and light up the skill
    // in the resources panel exactly as a model-initiated load would.
    wrapper.classList.add("skill");
    const badge = el("span", "bubble-badge skill-invocation", t.skillInvokedBadge);
    badge.title = t.skillInvokedTitle;
    bubbleBadgeColumn(wrapper).appendChild(badge);
    markSkillActive(skill);
  }
  if (!mode) return;
  wrapper.classList.add(mode === "steer" ? "steered" : "queued");
  // Run state is the primary badge, so keep it above an invoked-skill badge.
  bubbleBadgeColumn(wrapper).prepend(el("span", "bubble-badge", mode === "steer" ? t.steerBadge : t.queuedBadge));
  pendingUserBubbles.push({ element: wrapper, text, mode });
}

function bubbleBadgeColumn(bubble: HTMLElement): HTMLElement {
  const existing = bubble.querySelector<HTMLElement>(":scope > .bubble-badges");
  if (existing) return existing;
  const column = el("div", "bubble-badges");
  bubble.prepend(column);
  return column;
}

/**
 * Per-message session-tree actions, shown beside the bubble on hover once the
 * host has told us which entry it maps to (see `assignEntryIds`).
 *
 * "Rewind" is the frequent one: it moves the session back to this message and
 * returns its text to the composer, which is how a failed run gets retried
 * (optionally with another model). The session file is append-only, so the
 * abandoned branch survives and stays reachable from the tree navigator.
 */
function entryActionBar(): HTMLElement {
  const bar = el("div", "bubble-actions");
  bar.append(
    entryActionButton("switch", REWIND_ICON, t.entrySwitch, t.entrySwitchTitle),
    entryActionButton("fork", BRANCH_ICON, t.entryFork, t.entryForkTitle),
    entryActionButton("label", TAG_ICON, t.entryLabel, t.entryLabelTitle),
  );
  return bar;
}

function entryActionButton(
  action: "switch" | "fork" | "label",
  svg: string,
  label: string,
  title: string,
): HTMLButtonElement {
  const element = button(`bubble-action ${action}`, undefined, (event) => {
    const entryId = (event.currentTarget as HTMLElement).closest<HTMLElement>(".bubble.user")?.dataset.entryId;
    if (entryId) post({ type: "entryAction", action, entryId });
  });
  element.appendChild(icon(svg));
  // Icon-only button: the name survives in the tooltip and for screen readers.
  element.title = `${label} — ${title}`;
  element.setAttribute("aria-label", label);
  return element;
}

/**
 * Bind the user bubbles on screen to their session entries, in order.
 *
 * The host sends one id per user bubble it can act on; bubbles beyond that
 * (a message still queued, or any bubble in a read-only transcript) stay
 * unbound and therefore show no actions.
 */
export function assignEntryIds(ids: string[], labels: (string | undefined)[]): void {
  const bubbles = messagesEl.querySelectorAll<HTMLElement>(".bubble.user");
  bubbles.forEach((bubble, index) => {
    const id = ids[index];
    if (id) bubble.dataset.entryId = id;
    else delete bubble.dataset.entryId;
    const label = id ? labels[index] : undefined;
    const existing = bubble.querySelector(".label-badge");
    if (!label) {
      existing?.remove();
      return;
    }
    if (existing) existing.textContent = label;
    else {
      const badge = el("span", "bubble-badge label-badge", label);
      const column = bubble.querySelector<HTMLElement>(":scope > .bubble-badges");
      if (column) column.prepend(badge);
      else bubble.prepend(badge);
    }
  });
}

/**
 * Hide every per-message action while the transcript is not a stable, editable
 * view of the live session (a run in progress, a subagent, a preview).
 */
export function setEntryActionsLocked(locked: boolean): void {
  messagesEl.classList.toggle("actions-locked", locked);
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
    // belongs to this message, so it must no longer float. That also makes it
    // a boundary — the work block above it is the run the user interrupted, so
    // close it and let what follows open a fresh one.
    finishThinkingCard();
    finishWorkBlock();
    messagesEl.appendChild(pending.element);
    pendingUserBubbles.splice(i, 1);
  }
}

function normalizeUserBubble(element: HTMLElement): void {
  element.classList.remove("queued", "steered");
  const column = element.querySelector<HTMLElement>(":scope > .bubble-badges");
  column?.querySelector(":scope > .bubble-badge:not(.label-badge):not(.skill-invocation)")?.remove();
  if (column && column.childElementCount === 0) column.remove();
}

/**
 * Recall: queued messages went back to the composer, so their floating
 * bubbles disappear from the transcript entirely (CLI dequeue behavior).
 */
export function removePendingBubbles(): void {
  for (const pending of pendingUserBubbles) pending.element.remove();
  pendingUserBubbles.length = 0;
}

/** Whether any queued/steering bubbles are still waiting to be consumed. */
export function hasPendingBubbles(): boolean {
  return pendingUserBubbles.length > 0;
}

function createStreamingBubble(role: string): StreamingBubble {
  return { bubble: appendMarkdownBubble(role, ""), raw: "" };
}

/**
 * Status / error notices. Run-scoped notices (retry, compaction) are grouped
 * into the current work block as collapsed one-line cards. Command-scoped
 * notices (e.g. /session output) are the direct result the user asked for:
 * they render at the top level of the transcript, expanded by default.
 *
 * A notice carrying an action (`retry`) also stays at the top level whatever
 * its scope: work blocks are collapsed by default, and a button the user has
 * to go hunting for behind a fold is not an offer.
 */
export function appendNoticeCard(kind: "status" | "error", text: string, scope?: "command", retry?: RetryOfferState): void {
  const command = scope === "command";
  const parent = command || retry ? sink : ensureWorkBlock().collapsible.body;
  const firstLine = text.split("\n")[0] ?? "";
  const short = firstLine.length > MAX_NOTICE_HEADER_CHARS ? `${firstLine.slice(0, MAX_NOTICE_HEADER_CHARS)}...` : firstLine;
  // Nothing hidden behind the fold: render a flat, non-expandable card.
  if (short === text) {
    const card = el("div", `notice-card flat ${kind}${retry ? " actionable" : ""}`);
    card.appendChild(el("span", "card-label", text));
    if (retry) card.appendChild(createRetryButton(retry));
    parent.appendChild(card);
    return;
  }
  const card = createCollapsible({
    classes: CARD_CLASSES,
    rootClass: `notice-card ${kind}`,
    label: short,
    expanded: command,
    parent,
    render: (body) => body.replaceChildren(el("pre", "notice-body", text)),
  });
  // The collapsible header is itself a button, so the action goes in a row of
  // its own below it rather than inside the header.
  if (retry) {
    const actions = el("div", "notice-actions");
    actions.appendChild(createRetryButton(retry));
    card.root.appendChild(actions);
  }
  registerHiddenBody(card, () => text);
}

/**
 * Re-issue the request that failed, instead of typing "continue".
 *
 * The button is drawn from the state the host put on the notice, never from
 * local click state: the transcript is rebuilt from scratch on every replay
 * (session switch, preview, re-attach), so anything the button remembered on
 * its own would be lost there — and a card nobody rebuilds afterwards would
 * keep claiming a finished retry is still running.
 *
 * One shot per offer: a request that fails again closes its turn with a fresh
 * offer of its own, so a spent one stays on screen as its outcome.
 */
function createRetryButton(state: RetryOfferState): HTMLButtonElement {
  const retryButton = button("notice-action", undefined, () => {
    // Optimistic: the host answers with a rebuilt transcript, which is what
    // actually decides how this button looks from here on.
    paintRetryButton(retryButton, "running");
    post({ type: "retry" });
  });
  paintRetryButton(retryButton, state);
  return retryButton;
}

function paintRetryButton(retryButton: HTMLButtonElement, state: RetryOfferState): void {
  const label = state === "running"
    ? t.noticeRetrying
    : state === "succeeded"
      ? t.noticeRetrySucceeded
      : state === "failed"
        ? t.noticeRetryFailed
        : t.noticeRetry;
  retryButton.disabled = state !== "offered";
  retryButton.title = state === "offered" ? t.noticeRetryTitle : label;
  retryButton.replaceChildren(icon(RETRY_ICON), el("span", undefined, label));
}

/**
 * Persistent checkpoint between transcript phases. The full conversation stays
 * visible, while the expandable body shows the summary Pi now carries forward
 * together with some recent messages.
 */
function appendCompactionBoundary(summary: string, tokensBefore: number, estimatedTokensAfter?: number): void {
  const status = estimatedTokensAfter === undefined
    ? t.compactionTokensBefore(formatTokens(tokensBefore))
    : t.compactionTokens(formatTokens(tokensBefore), formatTokens(estimatedTokensAfter));
  const boundary = createCollapsible({
    classes: CARD_CLASSES,
    rootClass: "compaction-boundary",
    tag: "section",
    label: t.compactionBoundary,
    status,
    parent: sink,
    render: (body) => {
      body.append(el("p", "compaction-note", t.compactionContextNote));
      if (summary.trim()) {
        const rendered = el("div", "compaction-summary");
        rendered.append(renderMarkdown(summary));
        body.append(el("div", "compaction-summary-label", t.compactionSummary), rendered);
      }
    },
  });
  // The summary is the only body text worth finding; the note is boilerplate.
  registerHiddenBody(boundary, () => summary);
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

  // Position is a stable identity here: the same event sequence always groups
  // into the same blocks, whether replayed at once or appended live.
  const index = ++workBlockIndex;
  const work: WorkBlock = {
    collapsible: createCollapsible({
      classes: WORK_CLASSES,
      rootClass: "work-block running",
      tag: "section",
      label: t.workHeader,
      expanded: currentView.work.get(index)?.expanded ?? false,
      parent: sink,
    }),
    thinkingCount: 0,
    toolCount: 0,
    failedToolCount: 0,
    activeTools: new Map(),
  };
  updateWorkStatus(work);
  activeWorkBlock = work;
  workBlocks.set(index, work.collapsible);
  // No hidden-body text here: the work body is filled eagerly, only hidden.
  registerReveal(work.collapsible);
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
  registerHiddenBody(entry, () => entry.raw);
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

function startToolCard(id: string, name: string, args: unknown, skill?: SkillRef): void {
  const work = ensureWorkBlock();
  work.toolCount += 1;
  work.activeTools.set(id, name);
  // History replay funnels through here too, so the panel's "used here" mark
  // covers replayed transcripts as well as live runs.
  markToolUsed(name);
  updateWorkStatus(work, skill?.kind === "load" ? t.workLoadingSkill(skill.name) : t.workCalling(name));
  const entry = createCollapsible({
    classes: CARD_CLASSES,
    rootClass: "tool-card",
    label: name,
    status: t.running,
    parent: work.collapsible.body,
    render: (body) => {
      renderToolBody(toolCards.get(id) ?? entry, body);
      restoreToolScroll(id, body);
    },
  }) as ToolCard;
  entry.root.classList.add("running", "streaming");
  if (skill) markToolCardSkill(entry, skill);
  entry.toolName = name;
  entry.argsText = summarizeArgs(args);
  entry.bodyText = "";
  toolCards.set(id, entry);
  // While collapsed the body never renders, so its text (args, output, patch,
  // details) is searchable only through this region; the closure reads the
  // live entry, which tool_end keeps filling in.
  registerHiddenBody(entry, () =>
    [entry.argsText, entry.bodyText, entry.patch, flattenDetailText(entry.details)].filter(Boolean).join("\n"));
  // Expanded after the entry exists, because expanding renders the body and the
  // body reads back from `entry`. The delegation card is the only view of what
  // the subagents are doing, and the parent produces no output while it waits:
  // collapsed by default it would look like the window had frozen.
  if (name === SUBAGENT_TOOL) entry.setExpanded(true);
}

/**
 * Set a skill apart from an ordinary file access: the SDK reports a skill the
 * model loads on its own as a plain `read` of its SKILL.md, which is otherwise
 * indistinguishable from any other read in the work block.
 */
function markToolCardSkill(entry: ToolCard, skill: SkillRef): void {
  const load = skill.kind === "load";
  entry.root.classList.add(load ? "skill-load" : "skill-resource");
  const badge = el("span", load ? "skill-badge load" : "skill-badge", load ? t.skillLoadBadge(skill.name) : skill.name);
  badge.title = load ? t.skillLoadTitle : t.skillResourceTitle;
  entry.labelEl.appendChild(badge);
  if (load) markSkillActive(skill.name);
}

function endToolCard(event: Extract<ChatEvent, { kind: "tool_end" }>): void {
  // History replay has no preceding `tool_start`, so create the card on demand.
  if (!toolCards.has(event.id)) startToolCard(event.id, event.name, event.args, event.skill);
  const entry = toolCards.get(event.id);
  if (!entry) return;

  entry.statusEl.textContent = event.isError ? t.errorLabel : t.done;
  entry.root.classList.remove("running", "streaming");
  entry.root.classList.toggle("error", event.isError);
  entry.bodyText = event.text;
  entry.patch = event.patch;
  entry.path = event.path;
  entry.details = event.details;
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
  // The subagent card is built from `details` rather than from the
  // result text: while the call runs that payload is the only live view of what
  // each subagent is doing, and the parent produces no output of its own
  // meanwhile.
  if (entry.toolName === SUBAGENT_TOOL && renderLanes(entry, body)) return;
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
  if (entry.details !== undefined) renderDetailsBlock(entry.details, body);
}

/**
 * Per-subagent rows of a `subagent` call.
 *
 * Returns false when the payload is not the expected shape, so the card falls
 * back to the generic rendering rather than showing nothing.
 *
 * Each row carries what the user needs to decide whether to intervene: what it
 * is doing right now, what it may write, what it has written, and — once it is
 * over — how it ended. Rows are clickable (open that subagent's transcript,
 * read-only) and running ones can be stopped individually; the rest of the run
 * continues and the parent still receives a full report.
 */
function renderLanes(entry: ToolCard, body: HTMLElement): boolean {
  const details = entry.details;
  if (details === null || typeof details !== "object" || Array.isArray(details)) return false;
  const raw = (details as Record<string, JsonValue>).lanes;
  if (!Array.isArray(raw) || raw.length === 0) return false;

  const list = el("div", "lane-list");
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const lane = item as Record<string, JsonValue>;
    const status = typeof lane.status === "string" ? lane.status : "running";
    const row = el("div", `lane-row lane-${status}`);

    const head = el("div", "lane-head");
    head.appendChild(el("span", "lane-mark", laneMark(status)));
    const title = typeof lane.title === "string" ? lane.title : "subagent";
    head.appendChild(el("span", "lane-title", title));
    const scope = Array.isArray(lane.scope) ? lane.scope.filter((s): s is string => typeof s === "string") : [];
    if (scope.length > 0) head.appendChild(el("span", "lane-scope", scope.join(", ") || "."));
    row.appendChild(head);

    // While running the progress line is the whole point; afterwards the
    // outcome takes its place.
    const progress = typeof lane.progress === "string" ? lane.progress : undefined;
    const summary = typeof lane.summary === "string" ? lane.summary : undefined;
    const detail = status === "running" ? progress : summary;
    if (detail) row.appendChild(el("div", "lane-detail", truncate(detail, MAX_LANE_DETAIL_CHARS)));

    const written = Array.isArray(lane.writtenFiles)
      ? lane.writtenFiles.filter((f): f is string => typeof f === "string")
      : [];
    if (written.length > 0) {
      const label = status === "completed" ? t.laneWrote(written.length) : t.laneWroteBeforeStopping(written.length);
      row.appendChild(el("div", "lane-files", `${label}: ${written.join(", ")}`));
    }
    const violations = typeof lane.scopeViolations === "number" ? lane.scopeViolations : 0;
    if (violations > 0) row.appendChild(el("div", "lane-warning", t.laneScopeRefused(violations)));
    // Which files, not just how many: this is the list the parent has to finish
    // by hand, so it is worth a line of its own.
    const denied = Array.isArray(lane.deniedPaths)
      ? lane.deniedPaths.filter((p): p is string => typeof p === "string")
      : [];
    if (denied.length > 0) {
      row.appendChild(el("div", "lane-files", `${t.laneRefusedFiles}: ${denied.join(", ")}`));
    }
    if (lane.bashMayHaveWritten === true) row.appendChild(el("div", "lane-warning", t.laneBashUntracked));

    const actions = el("div", "lane-actions");
    const laneId = typeof lane.id === "string" ? lane.id : undefined;
    const sessionFile = typeof lane.sessionFile === "string" ? lane.sessionFile : undefined;
    if (laneId || sessionFile) {
      // Always opened as a subagent. The host uses the live child session when
      // it still has one and replays the session file otherwise (after a window
      // reload), but either way the title keeps the framing — falling back to a
      // plain preview would offer "back to the running session" with nothing
      // running.
      actions.append(
        button("secondary", t.laneView, () => post({ type: "showLane", laneId, sessionFile, title })),
      );
    }
    if (status === "running" && laneId) {
      actions.append(button("secondary", t.laneStop, () => post({ type: "stopLane", laneId })));
    }
    if (actions.childElementCount > 0) row.appendChild(actions);
    list.appendChild(row);
  }

  if (list.childElementCount === 0) return false;
  body.appendChild(list);
  return true;
}

function laneMark(status: string): string {
  switch (status) {
    case "completed":
      return "\u2713";
    case "failed":
      return "\u2717";
    case "stopped":
      return "\u25a0";
    default:
      return "\u25cf";
  }
}

/**
 * Generic, collapsed-by-default view of a tool's own `details` payload.
 *
 * A tool's `renderCall`/`renderResult` only ever produce pi-tui components
 * (ANSI lines), so their *presentation* cannot be reused here — but the data
 * behind them can. This draws that data in the webview's own idiom.
 *
 * Deliberately schema-free: every payload is rendered the same way, and no
 * extension gets special treatment. The host already bounded the size and
 * stripped anything unclonable (`agent/tool-details.ts`).
 */
function renderDetailsBlock(details: JsonValue, parent: HTMLElement): void {
  const block = createCollapsible({
    classes: CARD_CLASSES,
    rootClass: "tool-details-block",
    label: t.toolDetails,
    parent,
    render: (target) => appendDetailValue(target, details),
  });
  block.root.title = t.toolDetailsTitle;
  registerHiddenBody(block, () => flattenDetailText(details));
}

/**
 * Scalar values of a details payload as one line, keys excluded — the same
 * text the rendered tree shows, which is what search should match against.
 */
function flattenDetailText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "object") return String(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  return children
    .map((item) => flattenDetailText(item as JsonValue))
    .filter(Boolean)
    .join(" ");
}

function appendDetailValue(parent: HTMLElement, value: JsonValue): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      parent.appendChild(el("div", "detail-empty", "[]"));
      return;
    }
    value.forEach((item, index) => appendDetailRow(parent, String(index), item));
    return;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      parent.appendChild(el("div", "detail-empty", "{}"));
      return;
    }
    for (const [key, item] of entries) appendDetailRow(parent, key, item);
    return;
  }
  // A bare scalar at the root: no key to pair it with.
  parent.appendChild(el("div", "detail-value", formatDetailScalar(value)));
}

function appendDetailRow(parent: HTMLElement, key: string, value: JsonValue): void {
  const row = el("div", "detail-row");
  row.appendChild(el("span", "detail-key", key));
  if (value !== null && typeof value === "object") {
    const children = el("div", "detail-children");
    appendDetailValue(children, value);
    row.appendChild(children);
    row.classList.add("nested");
  } else {
    row.appendChild(el("span", "detail-value", formatDetailScalar(value)));
  }
  parent.appendChild(row);
}

/** Strings are shown unquoted; the key/value split already carries the shape. */
function formatDetailScalar(value: JsonValue): string {
  return value === null ? "null" : String(value);
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
  if (assistantBubble) assistantBubble.bubble.setText(assistantBubble.raw);
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
  if (state.isStreaming || state.isCompacting) {
    if (!workingEl) {
      workingEl = el("div", "working-row");
      workingLabelEl = el("span");
      workingEl.append(spinner(), workingLabelEl);
    }
    if (workingLabelEl) {
      const lane = currentLane();
      workingLabelEl.textContent = state.isCompacting
        ? ` ${t.compacting}`
        : state.delegation?.role === "parent" && isDelegating()
          ? ` ${t.waitingForSubagent}`
          : lane?.status === "running"
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
