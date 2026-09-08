import * as vscode from "vscode";
import type { SessionManager, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { t, tf } from "./i18n.js";
import type { PiRuntime } from "./runtime.js";
import { contentText, userDisplayFromText, userDisplayText } from "./session-title.js";

/**
 * 会话树操作（`/tree`、`/fork`、`/clone`）。
 *
 * 会话文件是一棵以 `id`/`parentId` 相连的条目树。CLI 用 TUI 选择器呈现，
 * 这里把同样的操作接到原生 QuickPick 上。
 */

/** 树 UI 需要的宿主回调；让本模块不依赖 bridge 细节。 */
export interface SessionTreeUi {
  status(text: string): void;
  /** 预填 composer，对齐 CLI 在 fork/导航后的编辑器恢复。 */
  setInput(text: string): void;
}

export interface TreeChoice extends vscode.QuickPickItem {
  entryId: string;
}

/** 原生 QuickPick 不能横向滚动，缩进必须有界。 */
const MAX_TREE_INDENT_DEPTH = 6;
const MAX_TREE_LABEL_CHARS = 10;

/** 就地切换活动分支，同 CLI 的 `/tree`。 */
export async function navigateSessionTree(runtime: PiRuntime, ui: SessionTreeUi): Promise<void> {
  const choices = buildTreeChoices(runtime.session.sessionManager);
  if (choices.length === 0) {
    ui.status(t("treeEmpty"));
    return;
  }
  const picked = await vscode.window.showQuickPick(choices, {
    title: t("treeNavigateTitle"),
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  const action = await vscode.window.showQuickPick(
    [
      { label: t("treeSwitchLabel"), detail: t("treeSwitchDetail"), action: "switch" as const },
      { label: t("treeForkLabel"), detail: t("treeForkDetail"), action: "fork" as const },
      { label: t("treeLabelLabel"), detail: t("treeLabelDetail"), action: "label" as const },
    ],
    { title: `Pi Agent Chat: ${picked.label.trim()}` },
  );
  if (!action) return;

  if (action.action === "switch") {
    await switchToEntry(runtime, picked.entryId, ui);
    return;
  }
  if (action.action === "fork") {
    await forkFromEntry(runtime, picked.entryId, ui);
    return;
  }

  await editEntryLabel(runtime, picked.entryId, ui);
}

/**
 * 把叶子指针移到 `entryId`，留在同一个会话文件里。
 *
 * 会话只追加：被放弃的路径保留着，仍可从树导航到达。落在用户消息上时
 * 把它的文本放回 composer、叶子指到其父条目，这样重发（可换模型）长出
 * 新分支而不是重复该消息。
 */
export async function switchToEntry(runtime: PiRuntime, entryId: string, ui: SessionTreeUi): Promise<void> {
  const result = await runtime.session.navigateTree(entryId);
  if (result.cancelled) {
    ui.status(t("treeNavigationCancelled"));
    return;
  }
  if (result.editorText) ui.setInput(userDisplayFromText(result.editorText));
  ui.status(t("treeSwitched"));
}

/** 设置或清除某条目的书签标签（只追加，不分叉）。 */
export async function editEntryLabel(runtime: PiRuntime, entryId: string, ui: SessionTreeUi): Promise<void> {
  const current = runtime.session.sessionManager.getLabel(entryId);
  const label = await vscode.window.showInputBox({
    title: t("treeLabelInputTitle"),
    value: current ?? "",
  });
  if (label === undefined) return;
  runtime.session.sessionManager.appendLabelChange(entryId, label.trim() || undefined);
  ui.status(label.trim() ? tf("treeLabelSet", label.trim()) : t("treeLabelCleared"));
}

/** 从较早的用户消息 fork 出新会话，同 CLI 的 `/fork`。 */
export async function pickForkPoint(runtime: PiRuntime, ui: SessionTreeUi): Promise<void> {
  const choices = buildTreeChoices(runtime.session.sessionManager, { userMessagesOnly: true });
  if (choices.length === 0) {
    ui.status(t("forkNoUserMessage"));
    return;
  }
  const picked = await vscode.window.showQuickPick(choices, {
    title: t("treeForkTitle"),
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;
  await forkFromEntry(runtime, picked.entryId, ui);
}

/** 在当前位置复制会话，同 CLI 的 `/clone`。 */
export async function cloneSession(runtime: PiRuntime, ui: SessionTreeUi): Promise<void> {
  const leaf = runtime.session.sessionManager.getLeafEntry();
  if (!leaf) {
    ui.status(t("cloneEmpty"));
    return;
  }
  const result = await runtime.fork(leaf.id, { position: "at" });
  ui.status(
    result.cancelled ? t("cloneCancelled") : tf("clonedInto", runtime.session.sessionFile ?? t("inMemorySession")),
  );
}

/**
 * 从某条目 fork 出新会话。
 *
 * 在某条目*之前* fork 只对用户消息有意义：SDK 会把那条消息作为编辑器
 * 文本交回以便改后重发，对其他条目则直接拒绝该 position。assistant 回答
 * 改为在*自身*处 fork——新会话保留到该回答为止的对话，那是它唯一说得
 * 通的读法。
 */
export async function forkFromEntry(runtime: PiRuntime, entryId: string, ui: SessionTreeUi): Promise<void> {
  const entry = runtime.session.sessionManager.getEntry(entryId);
  const position = entry && isUserMessage(entry) ? "before" : "at";
  const result = await runtime.fork(entryId, { position });
  if (result.cancelled) {
    ui.status(t("forkCancelled"));
    return;
  }
  if (result.selectedText) ui.setInput(userDisplayFromText(result.selectedText));
  ui.status(tf("forkedInto", runtime.session.sessionFile ?? t("inMemorySession")));
}

/**
 * 把条目树摊平成带缩进的 QuickPick 项。
 *
 * 导出供诊断使用：这是树 UI 里唯一不开 QuickPick 就能驱动的部分。
 */
export function buildTreeChoices(
  sessionManager: Pick<SessionManager, "getTree" | "getLeafEntry">,
  options: { userMessagesOnly?: boolean } = {},
): TreeChoice[] {
  const currentLeafId = sessionManager.getLeafEntry()?.id;
  const choices: TreeChoice[] = [];

  const walk = (nodes: readonly SessionTreeNode[], branchDepth: number): void => {
    for (const node of nodes) {
      const entry = node.entry as { id: string; type: string; timestamp?: string; message?: unknown; summary?: string };
      const display = describeEntry(entry);
      const listed = Boolean(display) && (!options.userMessagesOnly || isUserMessage(entry));
      if (display && listed) {
        const timestamp = entry.timestamp?.slice(0, 19).replace("T", " ");
        const description = [
          timestamp,
          node.label ? `[${node.label}]` : undefined,
          entry.id === currentLeafId ? t("current") : undefined,
        ]
          .filter((value): value is string => Boolean(value))
          .join(" · ");
        choices.push({
          entryId: entry.id,
          label: `${treeIndent(branchDepth)}${display.label}`,
          description: description || undefined,
          // 完整消息文本独立成行，不掺视觉缩进与标题元信息，
          // 便于阅读与搜索。
          detail: display.detail || undefined,
        });
      }
      // 线性链在视觉上不加深；只有进入真分叉处的备选分支才消耗一级缩进。
      walk(node.children, branchDepth + (node.children.length > 1 ? 1 : 0));
    }
  };

  walk(sessionManager.getTree(), 0);
  return choices;
}

function isUserMessage(entry: { type: string; message?: unknown }): boolean {
  return entry.type === "message" && (entry.message as { role?: string } | undefined)?.role === "user";
}

/** 条目的单行预览；不值得列出的条目返回 undefined。 */
function describeEntry(entry: { type: string; message?: unknown; summary?: string }): { label: string; detail: string } | undefined {
  if (entry.type === "compaction") {
    return {
      label: `· ${truncateTitle("compaction summary", MAX_TREE_LABEL_CHARS)}`,
      detail: (entry.summary ?? "").replace(/\s+/g, " ").trim(),
    };
  }
  if (entry.type !== "message") return undefined;

  const message = entry.message as { role?: string; content?: unknown } | undefined;
  if (!message?.role) return undefined;
  if (message.role === "toolResult") return undefined;

  // 标签在下面会做空白归一化，共享投影里的换行无所谓；要紧的是用户
  // 条目在这里读起来与 transcript、会话列表里的完全一致。
  const text = message.role === "user" ? userDisplayText(message.content) : contentText(message.content);
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  const prefix = message.role === "user" ? "> " : "· ";
  return {
    label: `${prefix}${truncateTitle(normalized, MAX_TREE_LABEL_CHARS)}`,
    detail: normalized,
  };
}

function truncateTitle(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function treeIndent(depth: number): string {
  const visibleDepth = Math.min(depth, MAX_TREE_INDENT_DEPTH);
  return `${"  ".repeat(visibleDepth)}${depth > MAX_TREE_INDENT_DEPTH ? "… " : ""}`;
}
