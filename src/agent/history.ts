/**
 * 持久化 transcript → `ChatEvent`。
 *
 * 回放必须产出与实时流完全相同的形状，webview 才能只有一条渲染路径。
 * 全是对会话条目的纯函数：无 VS Code API、无 bridge 状态，诊断命令因此
 * 能直接拿会话文件驱动它们。
 *
 * `bubbleEntryIds` 刻意与投影同居一文件——它必须与下面的投影逐条对应
 * （AGENTS.md 红线），让两件事保持同步最便宜的办法就是放在一起。
 */

import { isAbsolute, resolve as resolvePath } from "node:path";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ChatEvent } from "../shared/protocol.js";
import { EMPTY_PROMPT_INDEX, expandedPrompt, type PromptIndex } from "./invocations.js";
import { EMPTY_SKILL_INDEX, matchSkill, type SkillIndex } from "./skills.js";
import { contentImages, contentText, readUserDisplay, userDisplayText } from "./session-title.js";
import { sanitizeToolDetails } from "./tool-details.js";

/** 从 `AgentToolResult` 形状的值中提取纯文本。 */
export function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/**
 * 回放完整活动分支而非压缩感知的模型上下文。压缩条目变成可见边界；
 * 其 retainedTail 刻意不展开——那些消息在常规 Pi 会话里本来就在更早的
 * 位置，展开只会重复一遍。
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
    // 提示词模板展开后不留标记，这里只有无占位符的正文能追回它的
    // `/命令`。
    // 只有附件的消息在剥掉标记后没有文本，但它仍是用户发出的一条气泡：
    // `bubbleEntryIds` 用同一条规则，两个投影必须逐条对应。
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
 * assistant 消息的文本部分，与 transcript 气泡展示的完全一致。与
 * `bubbleEntryIds` 共用，保证第 k 个 id 属于第 k 个气泡——即使某条消息
 * 只带 thinking 或只有工具调用。
 */
function assistantMessageText(content: unknown): string {
  const parts = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

/**
 * transcript 所示各角色消息气泡对应的 session-entry id，按角色分组、
 * 保持原序。
 *
 * 与 `buildHistoryEntryEvents` 的 `role === "user"` / `role === "assistant"`
 * 分支镜像（同一投影、同一「空文本跳过」规则），使第 k 个 id 属于该角色
 * 的第 k 个气泡。压缩条目是边界、不是 retainedTail 气泡的来源，这里
 * 同样要跳过。导出供诊断使用。
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
        // 与 `appendHistoryMessage` 同一条「这里有没有气泡」的规则：
        // 纯图片消息显示无文本的气泡，这里漏掉会让之后所有 id 错一位。
        if (text.trim() || contentImages(message.content).length > 0) user.push(entry.id);
      } else if (message.role === "assistant") {
        if (assistantMessageText(message.content).trim()) assistant.push(entry.id);
      }
    }
  }
  return { user, assistant };
}

/** edit/write 工具经 `path` 参数指名目标文件。 */
export function toolFilePath(args: unknown, cwd: string): string | undefined {
  const path = (args as { path?: unknown } | undefined)?.path;
  if (typeof path !== "string" || !path.trim()) return undefined;
  return isAbsolute(path) ? path : resolvePath(cwd, path);
}
