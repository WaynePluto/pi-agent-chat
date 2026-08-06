/**
 * Message protocol between the extension host and the chat webview.
 *
 * Both sides import these types; the file must stay dependency-free so the
 * webview bundle does not pull in Node-only code.
 */

export type ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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

/** Active parent/child delegation as seen by the currently displayed session. */
export interface DelegationState {
  role: "parent" | "child";
  title: string;
  peerSessionId: string;
  peerSessionFile?: string;
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
  isStreaming: boolean;
  /** True when no provider has working auth: show the setup page instead of chat. */
  needsAuth?: boolean;
  /** Number of messages in the session (0 = brand-new empty session). */
  messageCount?: number;
  /** Present while a visible SDK child session is running. */
  delegation?: DelegationState;
  /** Present while another session is opened read-only during a run. */
  preview?: { file: string; title: string };
  /** Child sessions are read-only while delegated work is running. */
  inputDisabled?: boolean;
  stats?: ChatStats;
  error?: string;
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
 * [Prompts] / [Extensions] / [Themes]), rendered as a collapsible card at the
 * top of the transcript.
 */
export interface ResourceSection {
  name: string;
  /** Rows of the section, sorted by label; the webview groups them by scope. */
  items: ResourceItem[];
}

/**
 * Where a resource comes from. The webview groups each section by this instead
 * of tagging every row, so a row only carries its own name.
 */
export type ResourceScope = "global" | "project" | "package" | "other";

/** One row of a resource section. */
export interface ResourceItem {
  /** Compact label (skill name, `/prompt` name, file basename). */
  label: string;
  /** Absolute file to open on click; absent for rows that open nothing. */
  path?: string;
  /** Replaces `label` in the expanded row, e.g. an extension load error. */
  detail?: string;
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

/** One entry of the `/` autocomplete list. */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  kind: "builtin" | "prompt" | "extension" | "skill";
}

/** Simplified, serializable projection of `AgentSessionEvent`. */
export type ChatEvent =
  | { kind: "user_message"; text: string; mode?: "steer" | "followUp" }
  | { kind: "assistant_start" }
  | { kind: "text_delta"; delta: string }
  | { kind: "thinking_delta"; delta: string }
  /** Complete assistant text, used when replaying session history. */
  | { kind: "assistant_message"; text: string }
  /** Complete thinking text from history, rendered as a collapsed card. */
  | { kind: "thinking_message"; text: string }
  | { kind: "assistant_end" }
  | { kind: "tool_start"; id: string; name: string; args: unknown; skill?: SkillRef }
  | { kind: "tool_update"; id: string; text: string }
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
      /** Set when this call reads or runs part of a skill. */
      skill?: SkillRef;
    }
  | { kind: "agent_start" }
  | { kind: "agent_end" }
  /** All automatic retries, compaction and queued continuations have settled. */
  | { kind: "agent_settled" }
  | { kind: "queue_update"; steering: string[]; followUp: string[] }
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
      /** True when SYSTEM.md replaces Pi's default prompt and its bundled-docs guidance. */
      systemPromptOverridden?: boolean;
    }
  | { type: "sessions"; items: SessionListItem[] }
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
  /** During delegation, switch only the displayed transcript (not the runtime). */
  | { type: "showDelegationSession"; target: "parent" | "child" }
  /** Delete a persisted session file (asks for confirmation host-side). */
  | { type: "deleteSession"; file: string }
  /** Rename a session (host shows an input box; writes a session_info entry). */
  | { type: "renameSession"; file: string }
  /** Open the session tree navigator (switch branch / fork / label). */
  | { type: "openSessionTree" }
  /** Same three operations, applied to one message bubble in the transcript. */
  | { type: "entryAction"; action: "switch" | "fork" | "label"; entryId: string }
  | { type: "pickModel" }
  /** Start the provider sign-in flow (also used by the auth setup page). */
  | { type: "login" }
  /** Remove a credential stored by login. */
  | { type: "logout" }
  | { type: "pickThinkingLevel" }
  /** Open the settings menu (providers, shell path, ...). */
  | { type: "openSettings" }
  | { type: "openDiff"; path: string; patch: string }
  | { type: "openFile"; path: string };
