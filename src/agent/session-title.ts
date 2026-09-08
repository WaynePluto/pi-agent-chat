/**
 * 会话在 UI 里的标题规则。
 *
 * 会话列表、header 与重命名输入框必须一致：从未显式命名的会话也把
 * 首条用户消息当标题展示，重命名框的预填就得从同一段文本起步，
 * 而不是空白。
 */

import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { readSkillInvocation } from "./skills.js";
import { stripImageAttachmentMarkup } from "./images.js";

interface RoleContent {
  role?: string;
  content?: unknown;
}

/** 消息内容要么是纯字符串，要么是 content-part 数组。 */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => (part as { type?: string })?.type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("\n");
}

/**
 * 消息里的图片部分，按序返回。
 *
 * SDK 把附件作为 `ImageContent` 存在同一个 content 数组里，因此回放的
 * transcript 能展示用户附了什么图，而不是描述它的标记文本。
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
 * 用户消息在 transcript 里呈现的文本，连同它调用的技能：技能调用折回
 * 命令形式，图片附件标记剥掉（图本身另行渲染）。
 *
 * 该投影只在这里定义一次。所有展示用户消息的界面——transcript、header
 * 标题、会话列表、重命名预填、树导航——必须一致；每处自留一份拷贝的
 * 都已经分叉过一次：图片标记加进正文后，忘了剥的那几份开始把
 * `<image name="…">` 当标题显示。
 */
export function readUserDisplay(content: unknown): { text: string; skill?: string } {
  return readSkillInvocation(stripImageAttachmentMarkup(contentText(content)));
}

/** 只需要文本时的 {@link readUserDisplay}。 */
export function userDisplayText(content: unknown): string {
  return readUserDisplay(content).text;
}

/**
 * 输入已是纯文本时的同一投影，如会话列表扫描来的
 * `SessionInfo.firstMessage`。
 */
export function userDisplayFromText(text: string): string {
  return readSkillInvocation(stripImageAttachmentMarkup(text)).text;
}

/** 首条用户消息的首行，`<skill>` 块折回 `/skill:name`。 */
export function firstUserLine(messages: Iterable<RoleContent>): string | undefined {
  for (const raw of messages) {
    if (raw.role !== "user") continue;
    const text = userDisplayText(raw.content).trim();
    if (text) return text.split("\n")[0];
  }
  return undefined;
}

/**
 * 直接从 manager 读会话标题：用户命名优先，否则取首条用户消息。
 * 既覆盖非活动会话（`SessionManager.open()`），也覆盖条目还只在内存里的
 * 全新会话——所以读条目而不走磁盘扫描。
 */
export function sessionTitle(manager: SessionManager): string | undefined {
  const name = manager.getSessionName();
  if (name) return name;
  const messages: RoleContent[] = [];
  for (const entry of manager.getEntries()) messages.push(...sessionEntryToContextMessages(entry));
  return firstUserLine(messages);
}
