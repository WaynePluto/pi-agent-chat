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
  /** Compact one-line labels (skill names, /prompt names, file basenames). */
  items: string[];
  /** Full paths, shown when the card is expanded. */
  details: string[];
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
  | { kind: "tool_start"; id: string; name: string; args: unknown }
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
    }
  | { kind: "agent_start" }
  | { kind: "agent_end" }
  /** All automatic retries, compaction and queued continuations have settled. */
  | { kind: "agent_settled" }
  | { kind: "queue_update"; steering: string[]; followUp: string[] }
  | { kind: "status"; text: string }
  | { kind: "error"; text: string };

/** Extension host -> webview. */
export type HostMessage =
  | { type: "state"; state: ChatState }
  | { type: "event"; event: ChatEvent }
  /** Full transcript replay after startup or a session switch. */
  | { type: "history"; events: ChatEvent[] }
  | { type: "sessions"; items: SessionListItem[] }
  | { type: "commands"; items: SlashCommand[] }
  /** Startup resource listing, pinned above the transcript. */
  | { type: "resources"; sections: ResourceSection[] }
  /** Results for the webview @ project-file picker. */
  | { type: "projectFiles"; requestId: number; items: ProjectFileItem[]; error?: string }
  /** Prefill the composer, e.g. with the message a fork branched away from. */
  | { type: "setInput"; text: string }
  | { type: "clear" };

/** Webview -> extension host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "prompt"; text: string; references?: string[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "listProjectFiles"; requestId: number; query: string; includeIgnored: boolean }
  | { type: "abort" }
  | { type: "newSession" }
  | { type: "listSessions" }
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
  /** Open the session tree navigator (switch branch / fork / label). */
  | { type: "openSessionTree" }
  | { type: "pickModel" }
  /** Start the provider sign-in flow (also used by the auth setup page). */
  | { type: "login" }
  /** Remove a credential stored by login. */
  | { type: "logout" }
  | { type: "pickThinkingLevel" }
  | { type: "openDiff"; path: string; patch: string }
  | { type: "openFile"; path: string };
