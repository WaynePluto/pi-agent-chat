/**
 * Message protocol between the extension host and the chat webview.
 *
 * Both sides import these types; the file must stay dependency-free so the
 * webview bundle does not pull in Node-only code.
 */

export type ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Structured-clone-safe JSON, used for data the host forwards verbatim without
 * understanding its shape (currently tool `details`).
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Upper bound for `@` file references attached to a single prompt. Lives here
 * because both ends enforce it: the composer stops adding chips, the host
 * rejects over-long reference lists.
 */
export const MAX_FILE_REFERENCES = 10;

/**
 * Default of `piAgentChat.transcript.foldLines`. Lives here because three
 * places must agree on it: the manifest default, the host that pushes the
 * value to the webview, and the webview's fallback before the first push. A
 * message bubble folds to a preview once it exceeds this many lines
 * (unbroken text counts at a fixed chars-per-line rate, see
 * `webview/format.ts`); `0` disables folding.
 */
export const DEFAULT_FOLD_LINES = 14;

/**
 * Default of `piAgentChat.layout.contentMaxWidth`. Same triple-agreement rule as
 * `DEFAULT_FOLD_LINES`: the manifest default, the host that pushes the value,
 * and the webview's fallback before the first push must all agree on it.
 */
export const DEFAULT_CONTENT_MAX_WIDTH = 950;
/**
 * Bounds for that setting, shared by the settings manifest, the host-side
 * clamp (`agent/config.ts`) and the webview's clamp on incoming values: the
 * manifest's `minimum`/`maximum` only constrain the settings UI, so every
 * consumer of a hand-edited `settings.json` value must clamp for itself.
 * The floor is deliberately permissive: the composer's overflow controller
 * collapses its buttons before the column gets this tight, so it only guards
 * against a degenerate column, not against an uncomfortable one.
 */
export const CONTENT_WIDTH_MIN = 500;
export const CONTENT_WIDTH_MAX = 1400;
/**
 * Wide-layout geometry, mirrored in `src/styles/_wide.scss` (grid tracks) —
 * keep the two in sync. The wide layout activates once the webview is wide
 * enough to fit the chat column at its floor plus both rails at their
 * minimum, plus the grid's fixed horizontal chrome (two 12px gaps and two
 * 12px track-area paddings): see `wideLayoutMinWidth()` in `webview/main.ts`.
 */
export const CHAT_COLUMN_MIN_WIDTH = 700;
/** Minimum width of the sessions / resources rails in the wide grid. */
export const RAIL_MIN_WIDTH = 230;
/** Fixed horizontal chrome of the wide grid: two gaps + two paddings, 12px each. */
export const WIDE_GRID_CHROME_WIDTH = 48;

/** CLI-style footer statistics (mirrors the pi TUI status line). */
export interface ChatStats {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** Cache hit rate percent (0-100), or undefined when nothing was cached. */
  cacheHitPercent?: number;
  cost: number;
  /** Context usage percent of the window (0-100), if known. */
  contextPercent?: number;
  contextWindow?: number;
}

/**
 * Name of the one tool this extension adds to pi's own set.
 *
 * Deliberately the familiar ecosystem name: the model knows what a `subagent`
 * is for. The plugin owns the name in this window — an extension that
 * registers a same-named tool is shadowed (see `SubagentSetup`), and
 * the tool itself is the host's or nothing, never the extension's. Cross-host
 * resume is best-effort by design (see AGENTS.md): a CLI that has its own
 * `subagent` extension may see the model imitate the call shape recorded
 * here.
 */
export const SUBAGENT_TOOL = "subagent";

/**
 * Name of the terminal tool this extension adds to pi's own set.
 *
 * Prefixed rather than a bare `terminal`: the plugin owns every name it gives
 * one of its own tools (a same-named extension tool is shadowed, see
 * {@link ToolSetup}), so a name with a low collision rate is the cheap way to
 * keep that promise — and the prefix says which host the tool belonged to when
 * the session is read anywhere else.
 */
export const VSCODE_TERMINAL_TOOL = "vscode_terminal";

/**
 * How the session on screen was assembled with respect to one of this host's
 * own tools.
 *
 * The values travel together because the wording depends on both: the notice
 * about a shadowed extension must know whether the window's own tool is active
 * in its place, and with nothing shadowed a disabled tool still deserves a hint
 * pointing at the setting — both features are off by default and would
 * otherwise stay invisible.
 */
export interface ToolSetup {
  /** Whether this window's tool is part of this session's tool set. */
  enabled: boolean;
  /** Path of the pi extension that registered the suppressed same-named tool. */
  shadowedExtension?: string;
}

/** Historical name of {@link ToolSetup}, kept for the subagent call sites. */
export type SubagentSetup = ToolSetup;

/** One subagent of a running `subagent` call. */
export interface DelegationLane {
  id: string;
  title: string;
  /** Paths this subagent may write to, relative to the working directory. */
  scope: string[];
  status: "running" | "completed" | "failed" | "stopped";
  /**
   * What this subagent is doing right now, one line.
   *
   * The parent produces no output while it waits, so these lines carry the
   * entire sense of progress in the UI.
   */
  progress?: string;
  /** Files written through `edit`/`write` so far. */
  writtenFiles: string[];
  /** True once it ran a shell command, whose writes are not tracked. */
  bashMayHaveWritten?: boolean;
  /** Writes refused for leaving `scope`. */
  scopeViolations?: number;
  /** Which files were refused; the count alone cannot say what is left undone. */
  deniedPaths?: string[];
  sessionId?: string;
  sessionFile?: string;
  durationMs?: number;
}

/**
 * Subagent delegation as seen by the currently displayed session.
 *
 * Present on the parent while a run is in progress, and on a lane whenever one
 * is being viewed — including after the run finished, so the user is never
 * yanked out of a transcript they were reading.
 */
export interface DelegationState {
  /** Whether the displayed transcript is the parent's or one subagent's. */
  role: "parent" | "child";
  lanes: DelegationLane[];
  /** Set when `role` is `child`: which lane is on screen. */
  currentLaneId?: string;
  /** True while the run is still going. */
  running: boolean;
  /**
   * The parent moved on while the user was inside a lane. Drives the marker on
   * the back action instead of switching the view for them.
   */
  parentHasNewActivity?: boolean;
}

/**
 * Complete runtime-state snapshot rendered in the webview header/footer.
 * Every host `state` message replaces the prior snapshot; omitted optional
 * fields intentionally clear their previous UI state.
 */
export interface ChatState {
  ready: boolean;
  cwd?: string;
  sessionFile?: string;
  sessionId?: string;
  /** User-set display name, falling back to the first user message. */
  sessionName?: string;
  modelId?: string;
  providerId?: string;
  thinkingLevel?: string;
  /**
   * Thinking levels the current model accepts, in the SDK's order. A single
   * entry (or none) means the level is fixed and the composer hides its
   * selector.
   */
  thinkingLevels?: string[];
  isStreaming: boolean;
  /** Manual or automatic context compaction is in progress; submissions queue until it ends. */
  isCompacting: boolean;
  /** True when no provider has working auth: show the setup page instead of chat. */
  needsAuth?: boolean;
  /** Number of messages in the session (0 = brand-new empty session). */
  messageCount?: number;
  /** Present while a subagent delegation is running or being viewed. */
  delegation?: DelegationState;
  /** Present while a historical subagent session file is replayed read-only. */
  preview?: { file: string; title: string };
  /** Subagent transcripts are read-only: the user only ever talks to the parent. */
  inputDisabled?: boolean;
  stats?: ChatStats;
  error?: string;
}

/**
 * One row of the composer's quick model menu. Just enough to identify the
 * model: the full listing with capabilities, ⭐ and 📌 lives in the native
 * picker behind "other models".
 */
export interface ModelOption {
  provider: string;
  id: string;
}

/**
 * Models offered for quick switching: the frequently used ("scoped") ones in
 * their configured order, or every authenticated model when no scope is set.
 */
export interface ModelCatalog {
  items: ModelOption[];
}

export interface ProjectFileItem {
  /** Workspace-relative path, always using forward slashes. */
  path: string;
  ignored?: boolean;
  sensitive?: boolean;
}

export interface SessionListItem {
  file: string;
  title: string;
  timestamp?: string;
  /** True when this session is currently displayed in the chat view. */
  current?: boolean;
  /** True when this is the runtime session with a run in progress. */
  running?: boolean;
  /** Active task-line role, if this is the running child or waiting parent. */
  delegationRole?: "parent" | "child";
  /**
   * Another top-level controller owns this session. Both states are selectable:
   * the owner moves to the requesting surface without constructing a second
   * writer; a visible source is replaced with a fresh empty session.
   */
  claimedElsewhere?: "visible" | "background";
}


/**
 * One section of the CLI-style startup listing ([Context] / [Skills] /
 * [Prompts] / [Extensions] / [Tools]), rendered as a collapsible card at the
 * top of the transcript. The CLI's [Themes] section has no GUI counterpart:
 * the webview renders with VS Code theme variables and never loads a pi theme.
 * Only pi's own resource kinds appear here; directory conventions belonging to
 * a single extension do not.
 */
export interface ResourceSection {
  name: string;
  /** Rows of the section, sorted by label; the webview groups them by scope. */
  items: ResourceItem[];
}

/**
 * Where a resource comes from. The webview groups each section by this instead
 * of tagging every row, so a row only carries its own name. `builtin` covers
 * what ships with pi or with this extension: code, not a file the user wrote.
 */
export type ResourceScope = "builtin" | "global" | "project" | "package" | "other";

/** One row of a resource section. */
export interface ResourceItem {
  /** Compact label (skill name, `/prompt` name, file basename). */
  label: string;
  /** Absolute file to open on click; absent for rows that open nothing. */
  path?: string;
  /** Replaces `label` in the expanded row, e.g. an extension load error. */
  detail?: string;
  /** Extra tooltip text, e.g. a tool's description. */
  hint?: string;
  /**
   * Took effect in this session, as seen by the host: context files that went
   * out with a request, extensions whose handler ran or failed. The webview
   * adds what it can see itself (skills loaded, tools called, prompt templates
   * and extension commands invoked); a row is highlighted if either side says
   * so. See `agent/activity.ts`.
   */
  used?: boolean;
  /**
   * Known to the session but not in effect: a registered tool outside the
   * agent's active set, or an extension that failed to load. Rendered dimmed
   * instead of hidden, so the listing answers "is it off, or missing?". Every
   * other row is in effect, and is rendered in the plain foreground colour.
   */
  inactive?: boolean;
  scope: ResourceScope;
}

/**
 * Attribution of a tool call to a skill, resolved host-side by matching tool
 * arguments against the loaded skill paths. `load` marks the `SKILL.md` read
 * through which the model pulls in the skill's instructions; `resource` marks
 * any other file inside the same skill directory (scripts, references).
 */
export interface SkillRef {
  name: string;
  kind: "load" | "resource";
}

/**
 * One entry an extension published through `ctx.ui.setStatus(key, text)`.
 *
 * The SDK's own host renders these in the CLI footer (`FooterDataProvider`
 * calls them "extension statuses"); the sidebar's equivalent surface is the
 * status line. `key` is the extension's own identifier, used only to replace
 * or clear its previous entry — the plugin never interprets it.
 */
export interface ExtensionStatusItem {
  key: string;
  text: string;
}

/**
 * A block of lines an extension published through `ctx.ui.setWidget()`.
 *
 * Only the SDK's `string[]` overload crosses this protocol. The other overload
 * takes a `(tui, theme) => Component` factory, which is a TUI-only surface the
 * sidebar deliberately does not implement (see AGENTS.md, category 1); those
 * calls are dropped host-side rather than forwarded.
 */
export interface ExtensionWidget {
  key: string;
  lines: string[];
  /** Mirrors the SDK's `WidgetPlacement`, relative to the composer. */
  placement: "aboveEditor" | "belowEditor";
}

/** One entry of the `/` autocomplete list. */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  kind: "builtin" | "prompt" | "extension" | "skill";
}

/** Simplified, serializable projection of `AgentSessionEvent`. */
export type ChatEvent =
  /**
   * `skill` / `prompt` / `extension` attribute the message to the resource it
   * invoked, so the resources panel can light that row up (see
   * `agent/invocations.ts`). `extension` carries the providing extension's
   * absolute path, the same value its resource row opens.
   */
  | { kind: "user_message"; text: string; mode?: "steer" | "followUp"; skill?: string; prompt?: string; extension?: string }
  | { kind: "assistant_start" }
  | { kind: "text_delta"; delta: string }
  | { kind: "thinking_delta"; delta: string }
  /** Complete assistant text, used when replaying session history. */
  | { kind: "assistant_message"; text: string }
  /** Complete thinking text from history, rendered as a collapsed card. */
  | { kind: "thinking_message"; text: string }
  | { kind: "assistant_end" }
  | { kind: "tool_start"; id: string; name: string; args: unknown; skill?: SkillRef }
  /**
   * Partial result of a still-running tool.
   *
   * `details` carries the tool's own live payload; the subagent card is
   * built from it, which is what lets its per-subagent rows move while the call
   * is in progress.
   */
  | { kind: "tool_update"; id: string; text: string; details?: JsonValue }
  | {
      kind: "tool_end";
      id: string;
      name: string;
      isError: boolean;
      text: string;
      /** Present when replaying history, where no `tool_start` card exists yet. */
      args?: unknown;
      /** Unified patch from the `edit` tool, used to open a native diff view. */
      patch?: string;
      path?: string;
      /**
       * Tool-defined structured result (`AgentToolResult.details`), rendered as
       * a generic collapsed tree. Only carried for tools without a dedicated
       * card, and sanitized host-side (see `agent/tool-details.ts`).
       */
      details?: JsonValue;
      /** Set when this call reads or runs part of a skill. */
      skill?: SkillRef;
    }
  | { kind: "agent_start" }
  | { kind: "agent_end" }
  /** All automatic retries, compaction and queued continuations have settled. */
  | { kind: "agent_settled" }
  | { kind: "queue_update"; steering: string[]; followUp: string[] }
  /** Persistent marker appended when Pi replaces older model context with a summary. */
  | { kind: "compaction_boundary"; summary: string; tokensBefore: number; estimatedTokensAfter?: number }
  | {
      kind: "status";
      text: string;
      scope?: "command";
      /**
       * The notice reports a request automatic retry gave up on, and the
       * interrupted turn can still be re-issued. The webview draws a retry
       * action on the card and keeps it out of the (collapsed) work block, so
       * carrying on costs one click instead of a "continue" message that ends
       * up in the transcript and in the model context.
       *
       * The whole lifecycle of that action lives in this one field, owned by
       * the host: the button is drawn from it and never from local click
       * state, so leaving the session and coming back mid-retry shows the
       * same thing the user left behind.
       */
      retry?: RetryOfferState;
    }
  | { kind: "error"; text: string; scope?: "command" };

/**
 * State of the "re-issue the failed request" action carried by a notice.
 *
 * `offered` is the only clickable state; the other three are outcomes of a
 * click, and a click can only ever happen once per offer (a request that fails
 * again closes its turn with a fresh offer of its own).
 */
export type RetryOfferState = "offered" | "running" | "succeeded" | "failed";

/** Extension host -> webview. */
export type HostMessage =
  | { type: "state"; state: ChatState }
  /**
   * Fold threshold for message bubbles (`piAgentChat.transcript.foldLines`),
   * pushed on `ready` and whenever the setting changes, always followed by a
   * history replay: a bubble decides whether it folds while being built, so
   * the transcript must be rebuilt for a new threshold to reach bubbles that
   * already exist. Display config rather than runtime state, which is why it
   * travels outside `ChatState` and only when it changes.
   */
  | { type: "foldThreshold"; maxLines: number }
  /**
   * Whether thinking stays expanded while streaming
   * (`piAgentChat.transcript.showThinking`), pushed on `ready` and whenever
   * the setting changes, always followed by a history replay: like the fold
   * threshold, a card decides whether it opens expanded while it is being
   * built. Display config rather than runtime state, so it travels outside
   * `ChatState` and only when it changes.
   */
  | { type: "showThinking"; enabled: boolean }
  /**
   * Max width of the centered chat column (`piAgentChat.layout.contentMaxWidth`),
   * pushed on `ready` and whenever the setting changes. The webview writes it
   * into the `--content-max-width` custom property (transcript, composer and
   * the wide grid all size from it) and derives the wide-layout threshold from
   * it. Pure presentation with no baked-in decisions, so unlike the fold
   * threshold it needs no history replay.
   */
  | { type: "contentWidth"; maxWidth: number }
  | { type: "event"; event: ChatEvent }
  /** Full transcript replay after startup or a session switch. */
  | {
      type: "history";
      events: ChatEvent[];
      live?: boolean;
      /**
       * Identity of the transcript being shown (session id, or file for a
       * preview). The webview restores per-transcript view state — which work
       * blocks were expanded — when the same one is rebuilt, which happens
       * every time the user steps into a subagent and back out.
       */
      transcriptId?: string;
      /**
       * The replayed user messages enter the composer's ↑/↓ input history,
       * matching the CLI's initial render (`populateHistory: true`). Set only
       * when a session becomes the live one — attach and `ready` — never on
       * lane or preview round trips: those would re-add the same entries, and
       * a lane's opening "user message" is the task the parent agent wrote,
       * not something the user typed. The webview additionally remembers per
       * transcript, so the double post of a window start (attach, then ready)
       * still populates only once per webview lifetime.
       */
      populateInputHistory?: boolean;
      /** True when SYSTEM.md replaces Pi's default prompt and its bundled-docs guidance. */
      systemPromptOverridden?: boolean;
      /**
       * How this session was assembled with respect to the subagent tool:
       * whether the window's own tool is active, and which extension's
       * same-named registration was dropped for it (the name belongs to this
       * window's tool; see `SubagentSetup`). Part of the new-session notice
       * rather than a transcript event: it describes how this session is set
       * up, not something that happened in it.
       */
      subagent?: SubagentSetup;
      /**
       * The same for this host's `vscode_terminal` tool. A second field rather
       * than one list: the two are explained in different words, and the
       * notice has to say which tool it is talking about.
       */
      terminal?: ToolSetup;
    }
  | { type: "sessions"; items: SessionListItem[] }
  /** Answer to `listModels`, also pushed after credentials or markers change. */
  | { type: "models"; catalog: ModelCatalog }
  /** Open the composer's model picker from the host side (`/model`). */
  | { type: "openPicker"; picker: "model" }
  | { type: "commands"; items: SlashCommand[] }
  /** Startup resource listing, pinned above the transcript. */
  | { type: "resources"; sections: ResourceSection[] }
  /** Results for the webview @ project-file picker. */
  | { type: "projectFiles"; requestId: number; items: ProjectFileItem[]; error?: string }
  /**
   * Session-tree ids for the user bubbles currently on screen, in transcript
   * order, so each bubble can act on its own entry (switch / fork / label).
   * Shorter than the bubble list while messages are still queued, and empty
   * whenever acting on the displayed transcript is not allowed (preview,
   * subagent view).
   */
  | { type: "entryIds"; ids: string[]; labels: (string | undefined)[] }
  /**
   * Full replacement of the extension-owned status entries and widgets of the
   * session on screen. These are live UI state rather than transcript history,
   * so they travel outside `history`/`event` and are re-sent whenever the
   * displayed session changes.
   */
  | { type: "extensionStatus"; items: ExtensionStatusItem[] }
  | { type: "extensionWidgets"; items: ExtensionWidget[] }
  /** Prefill the composer, e.g. with the message a fork branched away from. */
  | { type: "setInput"; text: string }
  /** Queued messages were recalled: remove their bubbles, return texts to the composer. */
  | { type: "dequeued"; texts: string[] }
  | { type: "clear" };

/** Webview -> extension host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "prompt"; text: string; references?: string[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "listProjectFiles"; requestId: number; query: string; includeIgnored: boolean }
  | { type: "abort" }
  /** Re-issue the request that failed, without adding a user message (see `status.retry`). */
  | { type: "retry" }
  /** Clear all queued (steer/follow-up) messages; texts return to the composer. */
  | { type: "dequeue" }
  | { type: "newSession" }
  /** Narrow sessions page or wide sessions rail shown/hidden; scans run only while visible. */
  | { type: "sessionsVisible"; visible: boolean }
  | { type: "listCommands" }
  | { type: "resumeSession"; file: string }
  /** Move a session claimed by another top-level controller onto this surface. */
  | { type: "revealSession"; file: string }
  /**
   * Switch the displayed transcript between the parent and one subagent.
   *
   * `sessionFile` and `title` let the host keep the subagent framing even when
   * the child session object is gone (after a window reload, say): it replays
   * the session file instead, still presented as that subagent rather than as
   * an unrelated read-only preview.
   */
  | { type: "showLane"; laneId?: string; sessionFile?: string; title?: string }
  /** Stop one subagent; the others keep running and the parent still gets a report. */
  | { type: "stopLane"; laneId: string }
  /** Delete a persisted session file (asks for confirmation host-side). */
  | { type: "deleteSession"; file: string }
  /** Rename a session from the sessions list (host shows an input box; writes a session_info entry). */
  | { type: "renameSession"; file: string }
  /** Rename the live session from its header, including an empty session that has no file yet. */
  | { type: "renameCurrentSession" }
  /** Open the session tree navigator (switch branch / fork / label). */
  | { type: "openSessionTree" }
  /** Same three operations, applied to one message bubble in the transcript. */
  | { type: "entryAction"; action: "switch" | "fork" | "label"; entryId: string }
  /** Ask for the models offered by the composer's quick model menu. */
  | { type: "listModels" }
  /** Switch the model of the current session only. */
  | { type: "setModel"; provider: string; modelId: string }
  /** Open the native full model picker (search, capabilities, ⭐ / 📌). */
  | { type: "pickModel" }
  /** Start the provider sign-in flow (also used by the auth setup page). */
  | { type: "login" }
  /** Remove a credential stored by login. */
  | { type: "logout" }
  | { type: "setThinkingLevel"; level: string }
  /** Open the settings menu (providers, shell path, ...). */
  | { type: "openSettings" }
  | { type: "openDiff"; path: string; patch: string }
  | { type: "openFile"; path: string }
  /**
   * Copy text to the clipboard (message bubbles, code blocks).
   *
   * The host owns this the way it owns `openFile`: `navigator.clipboard` in a
   * webview is gated on focus and permissions that differ between desktop and
   * remote/browser hosts, while `vscode.env.clipboard` works everywhere.
   */
  | { type: "copyText"; text: string };
