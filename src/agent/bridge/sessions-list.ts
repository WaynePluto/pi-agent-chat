import * as vscode from "vscode";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionListItem } from "../../shared/protocol.js";
import { t } from "../i18n.js";
import { sessionTitle, userDisplayFromText } from "../session-title.js";
import type { ChatBridge } from "./chat-bridge.js";

export async function listSessions(bridge: ChatBridge): Promise<SessionListItem[]> {
  const sessions = await SessionManager.list(bridge.runtime.cwd);
  const displayedFile = bridge.view.kind === "replay" ? bridge.view.file : bridge.displayedSession.sessionFile;
  const runningFile = bridge.runtime.session.isStreaming || bridge.runtime.session.isCompacting
    ? bridge.runtime.session.sessionFile
    : undefined;
  /* 徽章在转，含义是「此刻正忙」，只有仍在进行的 run 的 lane 才能带它；
     完成的子代理就是普通会话。问窗口而非只问本 bridge：父会话已转后台
     的任务线仍是任务线，它的行不能在任何别的列表里变回普通（可打开
     的）会话。 */
  const delegationRole = (file: string) =>
    bridge.host.delegationRoleAt?.(file) ?? bridge.delegationRoleAt(file);
  const items: SessionListItem[] = sessions.map((info) => ({
    file: info.path,
    /* SDK 把展开的 <skill> 块存为首条用户消息、把附件存成 `<image …>`
       标记。按其他所有 surface 的方式投影，同一会话的行、header 标题与
       重命名预填才不会各说各话。 */
    title: info.name || userDisplayFromText(info.firstMessage) || t("emptySessionTitle"),
    timestamp: info.modified?.toISOString(),
    current: Boolean(displayedFile) && info.path === displayedFile,
    running: Boolean(runningFile) && info.path === runningFile,
    delegationRole: delegationRole(info.path),
    claimedElsewhere: bridge.host.claimedSessionLocation?.(info.path),
  }));
  /* SDK 把全新会话的写盘推迟到首条 assistant 消息完成，已有消息的会话
     可能不在扫描结果里；从内存并入，落盘后同路径的磁盘条目无缝接管。 */
  const live = bridge.runtime.session;
  if (live.sessionFile && live.messages.length > 0 && !items.some((item) => item.file === live.sessionFile)) {
    items.unshift({
      file: live.sessionFile,
      title: bridge.sessionDisplayName(live) ?? t("emptySessionTitle"),
      timestamp: new Date().toISOString(),
      current: live.sessionFile === displayedFile,
      running: live.isStreaming || live.isCompacting,
      delegationRole: delegationRole(live.sessionFile),
      claimedElsewhere: bridge.host.claimedSessionLocation?.(live.sessionFile),
    });
  }
  return items;
}

/**
 * 扫描会话文件的代价是 O(全部 JSONL 大小)，故只在会话页 / 宽栏可见时
 * 进行，本地与窗口级的失效突发合并为一次延迟扫描。
 */
export function refreshSessions(bridge: ChatBridge): void {
  if (!bridge.sessionsVisible || bridge.disposed) return;
  if (bridge.sessionsRefreshTimer) return;
  bridge.sessionsRefreshTimer = setTimeout(() => {
    bridge.sessionsRefreshTimer = undefined;
    void pushSessions(bridge);
  }, 300);
}

export async function pushSessions(bridge: ChatBridge): Promise<void> {
  if (!bridge.sessionsVisible || bridge.disposed) return;
  if (bridge.sessionsRefreshTimer) {
    clearTimeout(bridge.sessionsRefreshTimer);
    bridge.sessionsRefreshTimer = undefined;
  }
  const version = ++bridge.sessionsPostVersion;
  const items = await listSessions(bridge);
  if (bridge.disposed || !bridge.sessionsVisible || version !== bridge.sessionsPostVersion) return;
  bridge.host.post({ type: "sessions", items });
}

/** 跟踪窄模式会话页或宽模式会话栏是否在屏。 */
export function setSessionsVisible(bridge: ChatBridge, visible: boolean): void {
  bridge.sessionsVisible = visible;
  if (visible) {
    void pushSessions(bridge);
  } else {
    // 连在途扫描带未启动的防抖一起作废。
    bridge.sessionsPostVersion++;
  }
  if (!visible && bridge.sessionsRefreshTimer) {
    clearTimeout(bridge.sessionsRefreshTimer);
    bridge.sessionsRefreshTimer = undefined;
  }
}

/** 确认后删除会话文件；活动 run 的会话不可删。 */
export async function deleteSession(bridge: ChatBridge, file: string): Promise<void> {
  if (bridge.host.revealClaimedSession?.(file)) return;
  if (file === bridge.runtime.session.sessionFile || bridge.runningLaneFiles().includes(file)) {
    bridge.emitCommandError(t("deleteActiveSession"));
    return;
  }
  const confirmLabel = t("deleteSessionAction");
  const answer = await vscode.window.showWarningMessage(
    t("deleteSessionConfirm"),
    { modal: true, detail: file },
    confirmLabel,
  );
  if (answer !== confirmLabel) return;
  await vscode.workspace.fs.delete(vscode.Uri.file(file));
  await pushSessions(bridge);
  bridge.host.notifySessionsChanged?.();
}

/**
 * 重命名会话（`/name` 流程，header 与会话列表均可触发）。header 不带
 * file，连尚未落盘的空会话也能命名。活动会话走 `setSessionName()` 让
 * SDK 发出变更事件；其他会话文件经短命 SessionManager 追加一条
 * `session_info` 条目。运行中调用的子代理会话跳过（其 JSONL 正被追加）。
 */
export async function renameSession(bridge: ChatBridge, file?: string): Promise<void> {
  // 重命名只是追加元数据，不打扰运行中的会话，被 claim 的会话可从任何 surface 改名。
  if (file && (bridge.host.delegationRoleAt?.(file) ?? bridge.delegationRoleAt(file)) === "child") {
    bridge.emitCommandError(t("renameRunningSession"));
    return;
  }
  const isActive = !file || file === bridge.runtime.session.sessionFile;
  /* 预填列表展示的标题，让重命名总是在编辑它而非从零开始：未命名会话
     以首条用户消息为标题，只取 `getSessionName()` 会让输入框空着、旁边
     的行却明显有标题。非活动会话从自己的文件读取。 */
  let manager: SessionManager;
  let currentName: string | undefined;
  try {
    manager = isActive ? bridge.runtime.session.sessionManager : SessionManager.open(file!);
    currentName = sessionTitle(manager);
  } catch (error) {
    bridge.reportError(bridge.runtime.session, "rename session failed", error, "command");
    return;
  }
  const value = (
    await vscode.window.showInputBox({ title: t("sessionNameTitle"), value: currentName ?? "" })
  )?.trim();
  if (!value) return;
  try {
    if (isActive) {
      bridge.runtime.session.setSessionName(value);
    } else {
      manager.appendSessionInfo(value);
    }
  } catch (error) {
    bridge.reportError(bridge.runtime.session, "rename session failed", error, "command");
    return;
  }
  await pushSessions(bridge);
  bridge.host.notifySessionsChanged?.();
}
