/**
 * Persisted transcript → `ChatEvent`.
 *
 * A replay has to produce exactly the shapes the live stream produces, so the
 * webview keeps a single rendering path. Pure functions over session entries:
 * no VS Code API and no bridge state, which is what lets the diagnostics drive
 * them straight off a session file.
 *
 * `bubbleEntryIds` lives here on purpose — it must mirror the projection below
 * entry for entry (AGENTS.md red line), and the cheapest way to keep two
 * things in lockstep is to keep them in one file.
 */

import { isAbsolute, resolve as resolvePath } from "node:path";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ChatEvent } from "../shared/protocol.js";
import { EMPTY_PROMPT_INDEX, expandedPrompt, type PromptIndex } from "./invocations.js";
import { EMPTY_SKILL_INDEX, matchSkill, type SkillIndex } from "./skills.js";
import { contentImages, contentText, readUserDisplay, userDisplayText } from "./session-title.js";
import { sanitizeToolDetails } from "./tool-details.js";

/** Extract plain text from an `AgentToolResult`-shaped value. */
export function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/**
 * Replay the complete active branch rather than the compaction-aware model
 * context. Compaction entries become visible boundaries; their retainedTail is
 * deliberately not expanded because those messages already exist earlier in a
 * regular Pi session and would otherwise be duplicated.
 */
export function buildHistoryEntryEvents(
  entries: readonly SessionEntry[],
  cwd: string,
  skills: SkillIndex = EMPTY_SKILL_INDEX,
  prompts: PromptIndex = EMPTY_PROMPT_INDEX,
): ChatEvent[] {
  const events: ChatEvent[] = [];
  const toolArgs = new Map<string, unknown>();
  for (const entry of entries) {
    if (entry.type === "compaction") {
      events.push({
        kind: "compaction_boundary",
        summary: entry.summary,
        tokensBefore: entry.tokensBefore,
      });
      continue;
    }
    for (const message of sessionEntryToContextMessages(entry)) {
      appendHistoryMessage(events, toolArgs, message, cwd, skills, prompts);
    }
  }
  return events;
}

function appendHistoryMessage(
  events: ChatEvent[],
  toolArgs: Map<string, unknown>,
  raw: unknown,
  cwd: string,
  skills: SkillIndex,
  prompts: PromptIndex,
): void {
  const message = raw as {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    stopReason?: string;
    errorMessage?: string;
    details?: { patch?: string; path?: string };
  };

  if (message.role === "user") {
    const { text, skill } = readUserDisplay(message.content);
    const images = contentImages(message.content);
    // Prompt templates leave no marker once expanded, so only placeholder-free
    // bodies can be traced back to their `/command` here.
    // An attachment-only message has no text left after the markup is stripped,
    // but it is still a bubble the user sent: `bubbleEntryIds` applies the same
    // rule, and the two projections must agree entry for entry.
    if (text.trim() || images.length > 0) {
      events.push({
        kind: "user_message",
        text,
        skill,
        prompt: skill ? undefined : expandedPrompt(prompts, text),
        images: images.length > 0 ? images : undefined,
      });
    }
    return;
  }

  if (message.role === "assistant") {
    const parts = Array.isArray(message.content) ? (message.content as Array<Record<string, unknown>>) : [];
    const thinking = parts
      .filter((part) => part.type === "thinking" && typeof part.thinking === "string")
      .map((part) => part.thinking as string)
      .join("\n\n");
    if (thinking.trim()) events.push({ kind: "thinking_message", text: thinking });
    const text = assistantMessageText(message.content);
    if (text.trim()) events.push({ kind: "assistant_message", text });
    for (const part of parts) {
      if (part.type === "toolCall" && typeof part.id === "string") toolArgs.set(part.id, part.arguments);
    }
    if (message.stopReason === "error" && message.errorMessage) {
      events.push({ kind: "error", text: message.errorMessage });
    }
    return;
  }

  if (message.role === "toolResult" && typeof message.toolCallId === "string") {
    const args = toolArgs.get(message.toolCallId);
    events.push({
      kind: "tool_end",
      id: message.toolCallId,
      name: message.toolName ?? "tool",
      isError: Boolean(message.isError),
      text: contentText(message.content),
      args,
      patch: typeof message.details?.patch === "string" ? message.details.patch : undefined,
      path: toolFilePath(args, cwd),
      details: sanitizeToolDetails(message.toolName ?? "", message.details),
      skill: matchSkill(skills, message.toolName ?? "", args, cwd),
    });
  }
}

/**
 * The text parts of an assistant message, exactly as the transcript bubble
 * shows them. Shared with `bubbleEntryIds` so the k-th id belongs to the k-th
 * bubble even when a message carries only thinking or only tool calls.
 */
function assistantMessageText(content: unknown): string {
  const parts = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

/**
 * Session-entry ids of the message bubbles a transcript shows, per role and in
 * the same order.
 *
 * Mirrors the `role === "user"` / `role === "assistant"` branches of
 * `buildHistoryEntryEvents` (same projection and "skip empty text" rule) so the
 * k-th id belongs to the k-th bubble of that role. Compaction entries are
 * boundaries, not sources of retainedTail bubbles, and must therefore be
 * skipped here too. Exported for diagnostics.
 */
export function bubbleEntryIds(entries: readonly SessionEntry[]): { user: string[]; assistant: string[] } {
  const user: string[] = [];
  const assistant: string[] = [];
  for (const entry of entries) {
    if (entry.type === "compaction") continue;
    for (const raw of sessionEntryToContextMessages(entry)) {
      const message = raw as { role?: string; content?: unknown };
      if (message.role === "user") {
        const text = userDisplayText(message.content);
        // Same "is there a bubble here?" rule as `appendHistoryMessage`: an
        // image-only message shows a bubble with no text, and dropping it here
        // would shift every later id by one.
        if (text.trim() || contentImages(message.content).length > 0) user.push(entry.id);
      } else if (message.role === "assistant") {
        if (assistantMessageText(message.content).trim()) assistant.push(entry.id);
      }
    }
  }
  return { user, assistant };
}

/** The edit/write tools name their target file through the `path` argument. */
export function toolFilePath(args: unknown, cwd: string): string | undefined {
  const path = (args as { path?: unknown } | undefined)?.path;
  if (typeof path !== "string" || !path.trim()) return undefined;
  return isAbsolute(path) ? path : resolvePath(cwd, path);
}
