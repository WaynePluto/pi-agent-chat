import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Attributes a user message to the `/` command that produced it, so the
 * resources panel can light up the prompt template or the extension behind it.
 *
 * This is the non-skill half of the attribution done in `skills.ts`: the SDK
 * emits no "prompt template used" or "extension command ran" event, and both
 * are rewritten before anything is persisted:
 *
 * - `session.prompt()` replaces `/<template> args` with the template's expanded
 *   body (`core/prompt-templates.ts`), leaving no marker behind.
 * - An extension command is executed and never reaches the session file at all.
 *
 * Live submissions still carry the text the user typed, so that is where both
 * are resolved. On replay a prompt template can only be recovered when its body
 * contains no `$` placeholder, in which case the stored text is the body
 * verbatim; templates with arguments, and extension commands, simply go
 * unattributed (the panel shows "not seen used", never "switched off").
 */

/** One prompt template, with its body kept only when replay can match it. */
interface PromptEntry {
  name: string;
  /** Trimmed template body, or undefined when `$` placeholders make it unstable. */
  body?: string;
}

export type PromptIndex = readonly PromptEntry[];

export const EMPTY_PROMPT_INDEX: PromptIndex = [];

/** Snapshot the loaded prompt templates; rebuild after a session swap or `/reload`. */
export function buildPromptIndex(session: AgentSession): PromptIndex {
  try {
    return session.promptTemplates.map((template) => ({
      name: template.name,
      // `$1`, `$ARGUMENTS`, `${@:2}`, ... are substituted at expansion time, so
      // only placeholder-free bodies survive as an exact-match key.
      ...(template.content.includes("$") ? {} : { body: template.content.trim() }),
    }));
  } catch {
    return EMPTY_PROMPT_INDEX;
  }
}

/** What a submitted `/` command invokes, resolved before the session rewrites it. */
export interface CommandInvocation {
  /** Prompt template name, without the leading slash. */
  prompt?: string;
  /** Absolute path of the extension providing the invoked command. */
  extension?: string;
  /**
   * True when an extension command handles the text. Such a command runs
   * immediately and sends no prompt, so the caller must not treat it as a
   * queued/steering submission.
   */
  isExtensionCommand: boolean;
}

/**
 * Resolve a live submission against the session's own catalogues.
 *
 * Extension commands win over prompt templates, mirroring the order in
 * `AgentSession.prompt()` (commands are dispatched before templates expand).
 */
export function resolveInvocation(session: AgentSession, text: string): CommandInvocation {
  if (!text.startsWith("/")) return { isExtensionCommand: false };
  const separator = text.indexOf(" ");
  const name = separator === -1 ? text.slice(1) : text.slice(1, separator);
  if (!name) return { isExtensionCommand: false };

  try {
    const command = session.extensionRunner.getRegisteredCommands().find((entry) => entry.invocationName === name);
    if (command) {
      const path = command.sourceInfo?.path;
      return { isExtensionCommand: true, ...(path ? { extension: path } : {}) };
    }
  } catch {
    // Fall through: an unavailable runner just means no attribution.
  }

  try {
    if (session.promptTemplates.some((template) => template.name === name)) return { prompt: name, isExtensionCommand: false };
  } catch {
    // Same: attribution is best-effort.
  }
  return { isExtensionCommand: false };
}

/**
 * Recover the template behind a stored user message, for the placeholder-free
 * bodies that are persisted verbatim. Returns undefined for everything else.
 */
export function expandedPrompt(index: PromptIndex, text: string): string | undefined {
  if (index.length === 0) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return index.find((entry) => entry.body === trimmed)?.name;
}
