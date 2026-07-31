import * as vscode from "vscode";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SlashCommand } from "../shared/protocol.js";
import type { PiRuntime } from "./runtime.js";
import { cloneSession, navigateSessionTree, pickForkPoint, type SessionTreeUi } from "./session-tree.js";

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
const BUILTIN_COMMANDS: Array<{ name: string; description: string; argumentHint?: string }> = [
  { name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
  { name: "thinking", description: "Select thinking level" },
  { name: "compact", description: "Manually compact the session context", argumentHint: "[instructions]" },
  { name: "name", description: "Set session display name", argumentHint: "<name>" },
  { name: "session", description: "Show session info and stats" },
  { name: "copy", description: "Copy last agent message to clipboard" },
  { name: "new", description: "Start a new session" },
  { name: "resume", description: "Resume a different session" },
  { name: "fork", description: "Create a new fork from a previous user message" },
  { name: "clone", description: "Duplicate the current session at the current position" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "import", description: "Import and resume a session from a JSONL file", argumentHint: "<path.jsonl>" },
  { name: "export", description: "Export the session JSONL to a file", argumentHint: "[path.jsonl]" },
  { name: "reload", description: "Reload extensions, skills, prompts and context files" },
  { name: "login", description: "Sign in to a model provider" },
  { name: "logout", description: "Remove a stored provider credential" },
];

export const BUILTIN_COMMAND_NAMES = new Set(BUILTIN_COMMANDS.map((command) => command.name));

/** Collect every command offered by autocomplete, mirroring the CLI's sources. */
export function collectSlashCommands(session: AgentSession): SlashCommand[] {
  const commands: SlashCommand[] = BUILTIN_COMMANDS.map((command) => ({ ...command, kind: "builtin" }));

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
  pickThinkingLevel(): Promise<void>;
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
    case "new":
      await actions.newSession();
      break;
    case "resume":
      await actions.resumeSession();
      break;
    case "model":
      await actions.pickModel(argument);
      break;
    case "thinking":
      await actions.pickThinkingLevel();
      break;
    case "compact": {
      actions.status("compacting context...");
      const result = await session.compact(argument || undefined);
      const after = result.estimatedTokensAfter ?? 0;
      actions.status(`compaction done: ${result.tokensBefore} -> ~${after} tokens`);
      break;
    }
    case "name": {
      const value = argument || (await vscode.window.showInputBox({ title: "Session name" }))?.trim();
      if (!value) break;
      session.setSessionName(value);
      actions.status(`session renamed to "${value}"`);
      break;
    }
    case "session":
      actions.status(formatSessionStats(session.getSessionStats()));
      break;
    case "copy": {
      const last = session.getLastAssistantText();
      if (!last) {
        actions.status("no assistant message to copy");
        break;
      }
      await vscode.env.clipboard.writeText(last);
      actions.status("last assistant message copied");
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
      title: "Import pi session",
      filters: { "Session JSONL": ["jsonl"] },
      canSelectMany: false,
    });
    target = picked?.[0]?.fsPath ?? "";
  }
  if (!target) return;
  await runtime.importSession(target);
  actions.status(`imported ${target}`);
}

async function exportSession(runtime: PiRuntime, argument: string, actions: BuiltinCommandActions): Promise<void> {
  const source = runtime.session.sessionFile;
  if (!source) {
    actions.status("this session is not persisted, nothing to export");
    return;
  }
  let target = argument;
  if (!target) {
    const picked = await vscode.window.showSaveDialog({
      title: "Export pi session",
      filters: { "Session JSONL": ["jsonl"] },
      saveLabel: "Export",
    });
    target = picked?.fsPath ?? "";
  }
  if (!target) return;
  await vscode.workspace.fs.copy(vscode.Uri.file(source), vscode.Uri.file(target), { overwrite: true });
  actions.status(`exported to ${target}`);
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
