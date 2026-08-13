/**
 * How a session is titled in the UI.
 *
 * The sessions list, the header and the rename input all have to agree: a
 * session that was never explicitly named still shows its first user message
 * as a title, so the rename box must start from that same text instead of
 * being empty.
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { collapseSkillInvocation } from "./skills.js";

interface RoleContent {
  role?: string;
  content?: unknown;
}

/** Message content is either a plain string or a content-part array. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => (part as { type?: string })?.type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("\n");
}

/** First line of the first user message, with `<skill>` blocks collapsed back to `/skill:name`. */
export function firstUserLine(messages: Iterable<RoleContent>): string | undefined {
  for (const raw of messages) {
    if (raw.role !== "user") continue;
    const text = collapseSkillInvocation(contentText(raw.content)).trim();
    if (text) return text.split("\n")[0];
  }
  return undefined;
}

/**
 * Title of a session read straight off its manager: the user-set name, else
 * the first user message. Works for sessions that are not the active one
 * (`SessionManager.open()`) and for a brand-new one whose entries are still
 * only in memory, which is why it reads entries rather than the disk scan.
 */
export function sessionTitle(manager: SessionManager): string | undefined {
  const name = manager.getSessionName();
  if (name) return name;
  const messages: RoleContent[] = [];
  for (const entry of manager.getEntries()) messages.push(...sessionEntryToContextMessages(entry));
  return firstUserLine(messages);
}
