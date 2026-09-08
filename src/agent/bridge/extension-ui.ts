import { basename } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ExtensionWidget } from "../../shared/protocol.js";
import { tf } from "../i18n.js";
import type { ChatBridge } from "./chat-bridge.js";

/**
 * 把扩展的 `ctx.ui.notify` 引入 transcript。命令执行期间的提示是用户要的
 * 结果（顶层、展开）；否则是后台提示（进 work block）。
 */
export function extensionNoticeSink(
  bridge: ChatBridge,
  session: AgentSession,
  notice: { level: string; text: string },
): void {
  bridge.emit(session, {
    kind: notice.level === "error" ? "error" : "status",
    text: notice.text,
    scope: bridge.extensionCommandDepth > 0 ? "command" : undefined,
  });
}

/**
 * 把扩展 handler 的失败引入 transcript：不接的话 SDK 会静默丢弃（CLI 各
 * mode 都上报）。抛过错的 handler 就是跑过的 handler，同时点亮资源面板
 * 里该扩展。
 */
export function extensionErrorSink(
  bridge: ChatBridge,
  session: AgentSession,
  error: { extensionPath: string; event: string; error: string },
): void {
  bridge.host.log(`extension error (${error.extensionPath}) on ${error.event}: ${error.error}`);
  bridge.emit(session, {
    kind: "error",
    text: tf("extensionHandlerFailed", basename(error.extensionPath), error.event, error.error),
    scope: bridge.extensionCommandDepth > 0 ? "command" : undefined,
  });
  if (bridge.activity.markExtension(error.extensionPath)) bridge.postResourceListing();
}

/** 存放一次 `ctx.ui.setStatus` 更新；会话在屏上时即时下发。 */
export function extensionStatusSink(
  bridge: ChatBridge,
  session: AgentSession,
  update: { key: string; text?: string },
): void {
  const entries = bridge.extensionStatuses.get(session.sessionId) ?? new Map<string, string>();
  if (update.text === undefined) entries.delete(update.key);
  else entries.set(update.key, update.text);
  bridge.extensionStatuses.set(session.sessionId, entries);
  if (bridge.isDisplayed(session)) postExtensionStatus(bridge);
}

/** 存放一次 `ctx.ui.setWidget` 更新；会话在屏上时即时下发。 */
export function extensionWidgetSink(
  bridge: ChatBridge,
  session: AgentSession,
  update: { key: string; lines?: string[]; placement: ExtensionWidget["placement"] },
): void {
  const entries = bridge.extensionWidgets.get(session.sessionId) ?? new Map<string, ExtensionWidget>();
  if (update.lines === undefined) entries.delete(update.key);
  else entries.set(update.key, { key: update.key, lines: update.lines, placement: update.placement });
  bridge.extensionWidgets.set(session.sessionId, entries);
  if (bridge.isDisplayed(session)) postExtensionWidgets(bridge);
}

/**
 * 下发当前显示会话的扩展状态与 widget。历史 lane 回放展示的是扩展未绑定
 * 的 transcript，因此拿到空集而非 live 会话的那份。
 */
export function postExtensionStatus(bridge: ChatBridge): void {
  if (bridge.disposed) return;
  const session = bridge.displayedSession;
  const entries = bridge.view.kind === "replay" ? undefined : bridge.extensionStatuses.get(session.sessionId);
  bridge.host.post({
    type: "extensionStatus",
    items: [...(entries?.entries() ?? [])].map(([key, text]) => ({ key, text })),
  });
}

export function postExtensionWidgets(bridge: ChatBridge): void {
  if (bridge.disposed) return;
  const session = bridge.displayedSession;
  const entries = bridge.view.kind === "replay" ? undefined : bridge.extensionWidgets.get(session.sessionId);
  bridge.host.post({ type: "extensionWidgets", items: [...(entries?.values() ?? [])] });
}

/**
 * 丢弃一个会话的扩展状态与 widget。用于 reload：旧扩展实例已拆、
 * `session_start` 尚未到达新实例的空档——这些条目属于旧实例，新实例会
 * 重发仍然成立的部分（与 `attach()` 同一契约）。
 */
export function clearExtensionUiState(bridge: ChatBridge, session: AgentSession): void {
  bridge.extensionStatuses.delete(session.sessionId);
  bridge.extensionWidgets.delete(session.sessionId);
  if (!bridge.isDisplayed(session)) return;
  postExtensionStatus(bridge);
  postExtensionWidgets(bridge);
}
