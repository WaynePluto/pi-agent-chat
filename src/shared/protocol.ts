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
 * Deliberately not `subagent`: that name is taken in the CLI ecosystem, and a
 * same-named tool with different parameters would make sessions unreadable
 * across the two hosts — resuming in the CLI, the model would copy the call
 * shape it sees in the history and get an argument error.
 */
export const PARALLEL_SUBAGENT_TOOL = "parallel_subagent";

/**
 * Notice that an extension-registered `subagent` tool was suppressed.
 *
 * The two values travel together because the wording depends on both: what the
 * user gets instead is `parallel_subagent`, which is off unless opted in, so
 * saying "use this window's own subagent" would be wrong for most sessions.
 */
export interface ShadowedSubagentNotice {
  /** Path of the pi extension that registered the suppressed tool. */
  path: string;
  /** Whether `parallel_subagent` is part of this session's tool set. */
  parallelSubagentEnabled: boolean;
}

/** One subagent of a running `parallel_subagent` call. */
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
 * Parallel delegation as seen by the currently displayed session.
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
  /** Present while a parallel delegation is running or being viewed. */
  delegation?: DelegationState;
  /** Present while another session is opened read-only during a run. */
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
   * `details` carries the tool's own live payload; the parallel subagent card is
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
  | { kind: "status"; text: string; scope?: "command" }
  | { kind: "error"; text: string; scope?: "command" };

/** Extension host -> webview. */
export type HostMessage =
  | { type: "state"; state: ChatState }
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
      /** True when SYSTEM.md replaces Pi's default prompt and its bundled-docs guidance. */
      systemPromptOverridden?: boolean;
      /**
       * Set when a pi extension registers a `subagent` tool, which is always
       * dropped in this host. Part of the new-session notice rather than a
       * transcript event: it describes how this session is set up, not
       * something that happened in it.
       */
      shadowedSubagent?: ShadowedSubagentNotice;
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
  /** Clear all queued (steer/follow-up) messages; texts return to the composer. */
  | { type: "dequeue" }
  | { type: "newSession" }
  /** Sessions page opened/closed; the host only scans session files while it is visible. */
  | { type: "sessionsVisible"; visible: boolean }
  | { type: "listCommands" }
  | { type: "resumeSession"; file: string }
  /** Open another session read-only, without replacing the runtime session. */
  | { type: "previewSession"; file: string }
  /** Return from a read-only preview to the live transcript. */
  | { type: "closePreview" }
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
  /** Rename a session (host shows an input box; writes a session_info entry). */
  | { type: "renameSession"; file: string }
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
  | { type: "openFile"; path: string };
