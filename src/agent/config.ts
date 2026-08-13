import * as vscode from "vscode";

/**
 * The plugin's own VS Code settings.
 *
 * Only capabilities that exist *solely* in this host belong here. Anything the
 * CLI also has stays in the shared `~/.pi/agent/` config, so a single settings
 * file cannot make the two hosts behave differently. See AGENTS.md, "配置项归属".
 *
 * Everything below is read per resource (workspace folder), because whether a
 * repository tolerates parallel writing agents is a property of the repository,
 * not of the user.
 */
const SECTION = "piAgentChat.parallelSubagent";

/**
 * Ceiling on the configured parallelism, enforced here as well as in
 * `package.json`.
 *
 * The manifest's `maximum` only constrains the settings UI; a hand-edited
 * `settings.json` can hold any number. The cap protects the feature's premise
 * rather than the machine: past a certain width nobody can follow N transcripts,
 * and "observable parallelism" stops being observable.
 */
export const MAX_PARALLEL_HARD_CAP = 8;

export interface ParallelSubagentConfig {
  /** Whether to offer the tool at all. Off unless the user opted in. */
  readonly enabled: boolean;
  /** Upper bound for one call; also published to the model as the schema limit. */
  readonly maxParallel: number;
  /** `provider/modelId`, or undefined to inherit the parent session's model. */
  readonly defaultModel?: string;
}

/**
 * Read the current configuration for a working directory.
 *
 * Call this when a session's tool set is built, not once at startup: the tool
 * set is fixed at construction time, so a changed setting only takes effect
 * through a session reload.
 */
export function readParallelSubagentConfig(cwd: string): ParallelSubagentConfig {
  const scope = vscode.Uri.file(cwd);
  const config = vscode.workspace.getConfiguration(SECTION, scope);
  const rawMax = config.get<number>("maxParallel") ?? 3;
  const rawModel = config.get<string>("defaultModel")?.trim();
  return {
    enabled: config.get<boolean>("enabled") ?? false,
    maxParallel: clampParallelism(rawMax),
    defaultModel: rawModel || undefined,
  };
}

/** Round and clamp a configured width into a usable number of child sessions. */
export function clampParallelism(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_PARALLEL_HARD_CAP, Math.max(1, Math.round(value)));
}

/** Whether a settings change event touches anything read by this module. */
export function affectsParallelSubagentConfig(event: vscode.ConfigurationChangeEvent, cwd: string): boolean {
  return event.affectsConfiguration(SECTION, vscode.Uri.file(cwd));
}

/* -- Writing ------------------------------------------------------------- */

/**
 * Where a write lands.
 *
 * Only the two scopes a user can reason about are offered: the repository's
 * own settings file and the personal one. Whether a repository tolerates
 * parallel writing agents is a property of the repository, which is why
 * workspace is the more interesting of the two.
 */
export type SettingsScope = "workspace" | "user";

/** The settings this form can write, keyed as in `package.json`. */
export type ParallelSubagentKey = "enabled" | "maxParallel" | "defaultModel";

/** True when a workspace target exists at all; otherwise only "user" works. */
export function hasWorkspaceScope(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
}

/**
 * The value explicitly stored at `scope`, or undefined when nothing is set
 * there and the value is inherited.
 *
 * Folder-level settings win over workspace-level ones, matching how VS Code
 * resolves a resource-scoped setting for this cwd.
 */
export function readParallelSubagentOverride<T>(cwd: string, scope: SettingsScope, key: ParallelSubagentKey): T | undefined {
  const info = vscode.workspace.getConfiguration(SECTION, vscode.Uri.file(cwd)).inspect<T>(key);
  if (!info) return undefined;
  return scope === "workspace" ? (info.workspaceFolderValue ?? info.workspaceValue) : info.globalValue;
}

/**
 * Persist one setting, or clear it when `value` is undefined.
 *
 * Writing through the configuration API rather than editing JSON keeps the
 * comment-free VS Code settings files formatted the way VS Code formats them,
 * and makes the change observable through `onDidChangeConfiguration` — which is
 * how the chat view learns to say that it applies to the next session.
 */
export async function writeParallelSubagentSetting(
  cwd: string,
  scope: SettingsScope,
  key: ParallelSubagentKey,
  value: boolean | number | string | undefined,
): Promise<void> {
  const target = scope === "workspace" ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const resource = scope === "workspace" ? vscode.Uri.file(cwd) : undefined;
  await vscode.workspace.getConfiguration(SECTION, resource).update(key, value, target);
}

/** Fully qualified id, for deep-linking into the Settings editor. */
export function parallelSubagentSettingId(key?: ParallelSubagentKey): string {
  return key ? `${SECTION}.${key}` : SECTION;
}
