import * as vscode from "vscode";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SlashCommand } from "../shared/protocol.js";
import type { PiRuntime } from "./runtime.js";
import { t, tf } from "./i18n.js";
import { isChinese } from "../shared/messages.js";
import { cloneSession, navigateSessionTree, pickForkPoint, type SessionTreeUi } from "./session-tree.js";
import { sessionTitle } from "./session-title.js";

/**
 * Slash commands for the sidebar.
 *
 * Names and descriptions follow the CLI's built-in command list so muscle
 * memory carries over. Commands that only make sense in a terminal TUI
 * (/hotkeys, /quit, /settings, ...) are intentionally not offered.
 *
 * Prompt templates, extension commands and `/skill:<name>` are NOT handled
 * here: `AgentSession.prompt()` already expands and dispatches them. This
 * module only surfaces them for autocomplete.
 */
const BUILTIN_COMMANDS: Array<{ name: string; description: string; descriptionZh: string; argumentHint?: string }> = [
  { name: "help", description: "List built-in commands", descriptionZh: "查看内置命令列表" },
  { name: "model", description: "Select model (opens selector UI)", descriptionZh: "选择模型（打开选择器）", argumentHint: "<provider/model>" },
  { name: "scoped-models", description: "Enable/disable models for the model picker", descriptionZh: "设置模型选择器中的常用模型" },
  { name: "compact", description: "Manually compact the session context", descriptionZh: "手动压缩会话上下文", argumentHint: "[instructions]" },
  { name: "name", description: "Set session display name", descriptionZh: "设置会话显示名称", argumentHint: "<name>" },
  { name: "session", description: "Show session info and stats", descriptionZh: "显示会话信息与统计" },
  { name: "copy", description: "Copy last agent message to clipboard", descriptionZh: "复制最后一条 agent 消息到剪贴板" },
  { name: "new", description: "Start a new session", descriptionZh: "开始新会话" },
  { name: "resume", description: "Resume a different session", descriptionZh: "恢复其他会话" },
  { name: "fork", description: "Create a new fork from a previous user message", descriptionZh: "从历史用户消息创建分支" },
  { name: "clone", description: "Duplicate the current session at the current position", descriptionZh: "在当前位置复制会话" },
  { name: "tree", description: "Navigate session tree (switch branches)", descriptionZh: "导航会话树（切换分支）" },
  { name: "import", description: "Import and resume a session from a JSONL file", descriptionZh: "从 JSONL 文件导入并恢复会话", argumentHint: "<path.jsonl>" },
  { name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)", descriptionZh: "导出会话（默认 HTML，可指定 .html/.jsonl 路径）", argumentHint: "[path]" },
  { name: "reload", description: "Reload extensions, skills, prompts and context files", descriptionZh: "重新加载扩展、技能、提示词与上下文文件" },
  { name: "login", description: "Sign in to a model provider", descriptionZh: "登录模型供应商" },
  { name: "logout", description: "Remove a stored provider credential", descriptionZh: "移除已存储的供应商凭据" },
];

export const BUILTIN_COMMAND_NAMES = new Set(BUILTIN_COMMANDS.map((command) => command.name));

/**
 * `/help` output: the built-in command directory as plain text, in the VS Code
 * display language. Note the `/` autocomplete list itself intentionally stays
 * English to align with the CLI; only this human-readable summary localizes.
 */
export function formatHelp(): string {
  const zh = isChinese(vscode.env.language);
  const rows = BUILTIN_COMMANDS.map((command) => ({
    usage: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
    description: zh ? command.descriptionZh : command.description,
  }));
  const width = Math.max(...rows.map((row) => row.usage.length));
  return rows.map((row) => `${row.usage.padEnd(width)}  ${row.description}`).join("\n");
}

/** Collect every command offered by autocomplete, mirroring the CLI's sources. */
export function collectSlashCommands(session: AgentSession): SlashCommand[] {
  const commands: SlashCommand[] = BUILTIN_COMMANDS.map(({ name, description, argumentHint }) => ({ name, description, argumentHint, kind: "builtin" }));

  for (const template of session.promptTemplates) {
    commands.push({
      name: template.name,
      description: describeSource(template.description, template.sourceInfo?.source),
      argumentHint: template.argumentHint,
      kind: "prompt",
    });
  }

  for (const command of session.extensionRunner.getRegisteredCommands()) {
    if (BUILTIN_COMMAND_NAMES.has(command.invocationName)) continue;
    commands.push({
      name: command.invocationName,
      description: describeSource(command.description, command.sourceInfo?.source),
      kind: "extension",
    });
  }

  if (session.settingsManager.getEnableSkillCommands()) {
    for (const skill of session.resourceLoader.getSkills().skills) {
      commands.push({
        name: `skill:${skill.name}`,
        description: describeSource(skill.description, skill.sourceInfo?.source),
        kind: "skill",
      });
    }
  }

  return commands;
}

function describeSource(description: string | undefined, source: string | undefined): string {
  const trimmed = source?.trim();
  if (!trimmed || trimmed === "auto" || trimmed === "local" || trimmed === "cli") return description ?? "";
  return description ? `[${trimmed}] ${description}` : `[${trimmed}]`;
}

export interface BuiltinCommandActions extends SessionTreeUi {
  newSession(): Promise<void>;
  resumeSession(): Promise<void>;
  pickModel(argument: string): Promise<void>;
  /** `/scoped-models`: maintain the frequently used model list. */
  manageScopedModels(): Promise<void>;
  reload(): Promise<void>;
  login(): Promise<void>;
  logout(): Promise<void>;
  /** Re-attach after the runtime replaced the active session (fork/clone/tree). */
  reattach(): Promise<void>;
  refresh(): void;
}

/**
 * Run a built-in command.
 *
 * Returns `false` when the text is not a built-in, in which case the caller
 * must forward it to `AgentSession.prompt()`.
 */
export async function runBuiltinCommand(
  runtime: PiRuntime,
  text: string,
  actions: BuiltinCommandActions,
): Promise<boolean> {
  if (!text.startsWith("/")) return false;
  const separator = text.indexOf(" ");
  const name = (separator === -1 ? text.slice(1) : text.slice(1, separator)).trim();
  const argument = separator === -1 ? "" : text.slice(separator + 1).trim();
  if (!BUILTIN_COMMAND_NAMES.has(name)) return false;

  const session = runtime.session;
  switch (name) {
    case "help":
      actions.status(formatHelp());
      break;
    case "new":
      await actions.newSession();
      break;
    case "resume":
      await actions.resumeSession();
      break;
    case "model":
      await actions.pickModel(argument);
      break;
    case "scoped-models":
      await actions.manageScopedModels();
      break;
    case "compact": {
      actions.status(t("compacting"));
      await session.compact(argument || undefined);
      // compaction_end becomes a persistent boundary with the summary and
      // token reduction; do not duplicate it with a transient command notice.
      break;
    }
    case "name": {
      // Same prefill rule as the sessions list: start from the title the user
      // already sees (name, else first user message) rather than an empty box.
      const value = argument || (await vscode.window.showInputBox({
        title: t("sessionNameTitle"),
        value: sessionTitle(session.sessionManager) ?? "",
      }))?.trim();
      if (!value) break;
      session.setSessionName(value);
      actions.status(tf("sessionRenamed", value));
      break;
    }
    case "session":
      actions.status(formatSessionStats(session.getSessionStats()));
      break;
    case "copy": {
      const last = session.getLastAssistantText();
      if (!last) {
        actions.status(t("noAssistantMessage"));
        break;
      }
      await vscode.env.clipboard.writeText(last);
      actions.status(t("copiedLastMessage"));
      break;
    }
    case "import":
      await importSession(runtime, argument, actions);
      break;
    case "fork":
      await pickForkPoint(runtime, actions);
      await actions.reattach();
      break;
    case "clone":
      await cloneSession(runtime, actions);
      await actions.reattach();
      break;
    case "tree":
      await navigateSessionTree(runtime, actions);
      await actions.reattach();
      break;
    case "export":
      await exportSession(runtime, argument, actions);
      break;
    case "reload":
      await actions.reload();
      actions.status(t("resourcesReloaded"));
      break;
    case "login":
      await actions.login();
      break;
    case "logout":
      await actions.logout();
      break;
  }
  actions.refresh();
  return true;
}

async function importSession(runtime: PiRuntime, argument: string, actions: BuiltinCommandActions): Promise<void> {
  let target = argument;
  if (!target) {
    const picked = await vscode.window.showOpenDialog({
      title: t("importSessionTitle"),
      filters: { "Session JSONL": ["jsonl"] },
      canSelectMany: false,
    });
    target = picked?.[0]?.fsPath ?? "";
  }
  if (!target) return;
  await runtime.importSession(target);
  actions.status(tf("importedSession", target));
}

/**
 * `/export`: mirror the CLI — default to a styled HTML transcript, fall back
 * to raw JSONL only when the target path ends with `.jsonl`.
 */
async function exportSession(runtime: PiRuntime, argument: string, actions: BuiltinCommandActions): Promise<void> {
  let target = argument;
  if (!target) {
    const picked = await vscode.window.showSaveDialog({
      title: t("exportSessionTitle"),
      filters: { "Session HTML": ["html"], "Session JSONL": ["jsonl"] },
      saveLabel: t("exportSessionAction"),
    });
    target = picked?.fsPath ?? "";
  }
  if (!target) return;
  const exported = target.endsWith(".jsonl")
    ? runtime.session.exportToJsonl(target)
    : await runtime.session.exportToHtml(target);
  actions.status(tf("exportedSession", exported));
}

function formatSessionStats(stats: {
  sessionFile?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  tokens: { input: number; output: number; total: number };
  cost: number;
}): string {
  return [
    `session ${stats.sessionId}`,
    stats.sessionFile ?? "(in-memory)",
    `${stats.userMessages} user / ${stats.assistantMessages} assistant messages, ${stats.toolCalls} tool calls`,
    `tokens: ${stats.tokens.total} (in ${stats.tokens.input}, out ${stats.tokens.output}), cost $${stats.cost.toFixed(4)}`,
  ].join("\n");
}
