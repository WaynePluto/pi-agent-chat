import * as vscode from "vscode";
import type { SessionManager, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { t, tf } from "./i18n.js";
import type { PiRuntime } from "./runtime.js";
import { collapseSkillInvocation } from "./skills.js";

/**
 * Session tree operations (`/tree`, `/fork`, `/clone`).
 *
 * The session file is a tree of entries linked by `id`/`parentId`. The CLI
 * exposes it through a TUI selector; here the same operations are driven by
 * native QuickPicks.
 */

/** Host callbacks the tree UI needs; keeps this module free of bridge details. */
export interface SessionTreeUi {
  status(text: string): void;
  /** Prefill the composer, mirroring the CLI's editor restore on fork/navigate. */
  setInput(text: string): void;
}

export interface TreeChoice extends vscode.QuickPickItem {
  entryId: string;
}

/** Switch the active branch in place, like the CLI's `/tree`. */
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
 * Move the leaf pointer to `entryId`, staying in the same session file.
 *
 * The session is append-only: the abandoned path is kept and stays reachable
 * from the tree navigator. Landing on a user message puts its text back in the
 * composer and the leaf on its parent, so re-sending (possibly with another
 * model) grows a new branch instead of duplicating the message.
 */
export async function switchToEntry(runtime: PiRuntime, entryId: string, ui: SessionTreeUi): Promise<void> {
  const result = await runtime.session.navigateTree(entryId);
  if (result.cancelled) {
    ui.status(t("treeNavigationCancelled"));
    return;
  }
  if (result.editorText) ui.setInput(collapseSkillInvocation(result.editorText));
  ui.status(t("treeSwitched"));
}

/** Set or clear the bookmark label on one entry (append-only, no branching). */
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

/** Fork from a previous user message into a new session, like the CLI's `/fork`. */
export async function pickForkPoint(runtime: PiRuntime, ui: SessionTreeUi): Promise<void> {
  const choices = buildTreeChoices(runtime.session.sessionManager, { userMessagesOnly: true });
  if (choices.length === 0) {
    ui.status(t("forkNoUserMessage"));
    return;
  }
  const picked = await vscode.window.showQuickPick(choices, {
    title: t("treeForkTitle"),
    matchOnDescription: true,
  });
  if (!picked) return;
  await forkFromEntry(runtime, picked.entryId, ui);
}

/** Duplicate the session at its current position, like the CLI's `/clone`. */
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
 * Fork before an entry: the new session keeps everything up to it, and the
 * message itself comes back as editor text so it can be edited and re-sent.
 */
export async function forkFromEntry(runtime: PiRuntime, entryId: string, ui: SessionTreeUi): Promise<void> {
  const result = await runtime.fork(entryId);
  if (result.cancelled) {
    ui.status(t("forkCancelled"));
    return;
  }
  if (result.selectedText) ui.setInput(collapseSkillInvocation(result.selectedText));
  ui.status(tf("forkedInto", runtime.session.sessionFile ?? t("inMemorySession")));
}

/**
 * Flatten the entry tree into indented QuickPick items.
 *
 * Exported for diagnostics: it is the only part of the tree UI that can be
 * exercised without opening a QuickPick.
 */
export function buildTreeChoices(
  sessionManager: Pick<SessionManager, "getTree" | "getLeafEntry">,
  options: { userMessagesOnly?: boolean } = {},
): TreeChoice[] {
  const currentLeafId = sessionManager.getLeafEntry()?.id;
  const choices: TreeChoice[] = [];

  const walk = (nodes: readonly SessionTreeNode[], depth: number): void => {
    for (const node of nodes) {
      const entry = node.entry as { id: string; type: string; timestamp?: string; message?: unknown };
      const summary = describeEntry(entry);
      const listed = Boolean(summary) && (!options.userMessagesOnly || isUserMessage(entry));
      if (summary && listed) {
        choices.push({
          entryId: entry.id,
          label: `${"  ".repeat(depth)}${node.label ? `[${node.label}] ` : ""}${summary}`,
          description: entry.id === currentLeafId ? t("current") : undefined,
          detail: entry.timestamp?.slice(0, 19).replace("T", " "),
        });
      }
      walk(node.children, depth + (summary ? 1 : 0));
    }
  };

  walk(sessionManager.getTree(), 0);
  return choices;
}

function isUserMessage(entry: { type: string; message?: unknown }): boolean {
  return entry.type === "message" && (entry.message as { role?: string } | undefined)?.role === "user";
}

/** One-line preview of an entry; returns undefined for entries not worth listing. */
function describeEntry(entry: { type: string; message?: unknown }): string | undefined {
  if (entry.type === "compaction") return "· compaction summary";
  if (entry.type !== "message") return undefined;

  const message = entry.message as { role?: string; content?: unknown } | undefined;
  if (!message?.role) return undefined;
  if (message.role === "toolResult") return undefined;

  const text = message.role === "user" ? collapseSkillInvocation(messageText(message.content)) : messageText(message.content);
  if (!text.trim()) return undefined;
  const prefix = message.role === "user" ? "> " : "· ";
  return `${prefix}${truncate(text.replace(/\s+/g, " ").trim(), 90)}`;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => (part as { type?: string })?.type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join(" ");
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
