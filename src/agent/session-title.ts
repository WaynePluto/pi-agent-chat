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
import { readSkillInvocation } from "./skills.js";
import { stripImageAttachmentMarkup } from "./images.js";

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

/**
 * Image parts of a message, in order.
 *
 * The SDK stores attachments as `ImageContent` inside the same content array,
 * so a replayed transcript can show what the user attached rather than the
 * markup that describes it.
 */
export function contentImages(content: unknown): { mimeType: string; data: string }[] {
  if (!Array.isArray(content)) return [];
  const images: { mimeType: string; data: string }[] = [];
  for (const raw of content) {
    const part = raw as { type?: string; data?: unknown; mimeType?: unknown };
    if (part?.type !== "image" || typeof part.data !== "string") continue;
    images.push({ mimeType: typeof part.mimeType === "string" ? part.mimeType : "image/png", data: part.data });
  }
  return images;
}

/**
 * The text of a user message as the transcript shows it, plus the skill it
 * invoked: skill invocations collapsed back to their command form, image
 * attachment markup dropped (the images themselves are rendered instead).
 *
 * The single place this projection is defined. Every surface that shows a user
 * message — transcript, header title, sessions list, rename prefill, the tree
 * navigator — has to agree, and each one that grew its own copy has drifted
 * exactly once already: the image markup was added to the prompt text and the
 * copies that forgot to strip it started showing `<image name="…">` as a title.
 */
export function readUserDisplay(content: unknown): { text: string; skill?: string } {
  return readSkillInvocation(stripImageAttachmentMarkup(contentText(content)));
}

/** {@link readUserDisplay} when only the text is wanted. */
export function userDisplayText(content: unknown): string {
  return readUserDisplay(content).text;
}

/**
 * The same projection for sources that are already plain text, such as
 * `SessionInfo.firstMessage` from the session-list scan.
 */
export function userDisplayFromText(text: string): string {
  return readSkillInvocation(stripImageAttachmentMarkup(text)).text;
}

/** First line of the first user message, with `<skill>` blocks collapsed back to `/skill:name`. */
export function firstUserLine(messages: Iterable<RoleContent>): string | undefined {
  for (const raw of messages) {
    if (raw.role !== "user") continue;
    const text = userDisplayText(raw.content).trim();
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
