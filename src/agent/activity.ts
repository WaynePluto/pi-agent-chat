import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ChatEvent } from "../shared/protocol.js";

/**
 * Tracks which listed resources actually took effect in the displayed session,
 * for the resources panel's "used here" colour.
 *
 * Two of the panel's sections cannot be attributed from the transcript alone:
 *
 * - **Context** files are inlined into the system prompt on every request
 *   (`core/system-prompt.ts` appends them unconditionally), so they leave no
 *   trace in the transcript at all. Once a single model request has gone out,
 *   every one of them has been handed to the model.
 * - **Extensions** show up in the transcript only when their `/command` runs or
 *   a tool they registered is called. An extension that only installs event
 *   handlers — the most common shape — would never light up. Handlers are not
 *   observable directly, but `Extension.handlers` lists the events each
 *   extension subscribed to, and the runner calls every handler registered for
 *   an event it emits. So an extension counts as having run as soon as an event
 *   it subscribed to has been emitted.
 *
 * Both readings are deliberately wide: they answer "did this take effect in
 * this conversation?", not "did the user see it happen?".
 */

/**
 * SDK-MIRROR: `core/agent-session.ts` emits `session_start` (and, right after
 * it, `resources_discover`) from `bindExtensions()`, so any extension listening
 * for them has run by the time binding resolves. `project_trust` is emitted
 * earlier still, while the resource loader loads the extensions.
 */
const BIND_EVENTS = ["session_start", "resources_discover", "project_trust"] as const;

/**
 * Extension events the SDK emits around one of our own session events, keyed by
 * the `AgentSessionEvent` type we observe.
 *
 * Extension events whose name matches the session event verbatim (`agent_start`,
 * `message_end`, `tool_execution_*`, `session_info_changed`, ...) need no entry:
 * they are matched by name.
 *
 * SDK-MIRROR: emit sites in `core/agent-session.ts` and `core/agent.ts`
 * (`emitInput` / `emitBeforeAgentStart` / `emitContext` /
 * `emitBeforeProviderRequest` / `emitBeforeProviderHeaders` around a run,
 * `emitToolCall` / `emitToolResult` around a tool call).
 */
const COMPANION_EVENTS: Readonly<Record<string, readonly string[]>> = {
  agent_start: ["input", "before_agent_start", "context", "before_provider_request", "before_provider_headers", "turn_start"],
  agent_end: ["turn_end"],
  message_end: ["after_provider_response"],
  tool_execution_start: ["tool_call"],
  tool_execution_end: ["tool_result"],
  compaction_start: ["session_before_compact"],
  compaction_end: ["session_compact"],
  thinking_level_changed: ["thinking_level_select"],
};

/** History events that prove the session already sent a request to the model. */
const REQUEST_SENT_KINDS: ReadonlySet<ChatEvent["kind"]> = new Set([
  "assistant_message",
  "assistant_start",
  "thinking_message",
  "tool_start",
  "tool_end",
]);

/** Read-only view handed to the listing builder. */
export interface ResourceActivity {
  /** True once the system prompt — context files included — has been sent. */
  readonly contextUsed: boolean;
  /** True when this extension's command, tool, handler or error was seen. */
  isExtensionUsed(path: string): boolean;
}

/**
 * Mutating side of {@link ResourceActivity}. Every marking method reports
 * whether something changed, so the caller only re-posts the listing when the
 * panel would actually look different.
 */
export class ActivityTracker implements ResourceActivity {
  private readonly extensions = new Set<string>();
  private requestSent = false;

  get contextUsed(): boolean {
    return this.requestSent;
  }

  isExtensionUsed(path: string): boolean {
    return this.extensions.has(path);
  }

  /** Drop everything; called when another session is attached. */
  reset(): void {
    this.extensions.clear();
    this.requestSent = false;
  }

  /** An extension ran, proven directly (its handler threw, its command ran). */
  markExtension(path: string): boolean {
    if (this.extensions.has(path)) return false;
    this.extensions.add(path);
    return true;
  }

  /** Replayed history: assistant output means the system prompt went out. */
  noteHistory(events: readonly ChatEvent[]): boolean {
    if (this.requestSent) return false;
    if (!events.some((event) => REQUEST_SENT_KINDS.has(event.kind))) return false;
    this.requestSent = true;
    return true;
  }

  /** Extensions bound: startup-time handlers have run by now. */
  noteBind(session: AgentSession): boolean {
    return this.markByEvents(session, BIND_EVENTS);
  }

  /** One `AgentSessionEvent` was observed; mark whoever it reached. */
  noteSessionEvent(session: AgentSession, type: string): boolean {
    // A run starting means the system prompt (context files included) is on
    // its way to the provider.
    let changed = false;
    if (type === "agent_start" && !this.requestSent) {
      this.requestSent = true;
      changed = true;
    }
    return this.markByEvents(session, [type, ...(COMPANION_EVENTS[type] ?? [])]) || changed;
  }

  /** Mark every extension subscribed to one of `events`. */
  private markByEvents(session: AgentSession, events: readonly string[]): boolean {
    let changed = false;
    for (const extension of loadedExtensions(session)) {
      if (this.extensions.has(extension.path)) continue;
      if (!events.some((event) => (extension.handlers.get(event)?.length ?? 0) > 0)) continue;
      this.extensions.add(extension.path);
      changed = true;
    }
    return changed;
  }
}

/** Loaded extensions, or nothing when the session cannot report them. */
function loadedExtensions(session: AgentSession): Array<{ path: string; handlers: Map<string, unknown[]> }> {
  try {
    return session.resourceLoader.getExtensions().extensions;
  } catch {
    return [];
  }
}
