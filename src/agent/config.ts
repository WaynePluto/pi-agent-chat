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
const SECTION = "piAgentChat.subagent";

/**
 * Ceiling on the configured width, enforced here as well as in
 * `package.json`.
 *
 * The manifest's `maximum` only constrains the settings UI; a hand-edited
 * `settings.json` can hold any number. The cap protects the feature's premise
 * rather than the machine: past a certain width nobody can follow N transcripts,
 * and "observable parallelism" stops being observable.
 */
export const SUBAGENT_HARD_CAP = 8;

export interface SubagentConfig {
  /** Whether to offer the tool at all. Off unless the user opted in. */
  readonly enabled: boolean;
  /** Upper bound for one call; also published to the model as the schema limit. */
  readonly maxSubagents: number;
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
export function readSubagentConfig(cwd: string): SubagentConfig {
  const scope = vscode.Uri.file(cwd);
  const config = vscode.workspace.getConfiguration(SECTION, scope);
  const rawMax = config.get<number>("maxSubagents") ?? 3;
  const rawModel = config.get<string>("defaultModel")?.trim();
  return {
    enabled: config.get<boolean>("enabled") ?? false,
    maxSubagents: clampSubagentLimit(rawMax),
    defaultModel: rawModel || undefined,
  };
}

/** Round and clamp a configured width into a usable number of child sessions. */
export function clampSubagentLimit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(SUBAGENT_HARD_CAP, Math.max(1, Math.round(value)));
}

/** Whether a settings change event touches anything read by this module. */
export function affectsSubagentConfig(event: vscode.ConfigurationChangeEvent, cwd: string): boolean {
  return event.affectsConfiguration(SECTION, vscode.Uri.file(cwd));
}

/* -- Deep link ----------------------------------------------------------- */

/**
 * Fully qualified section id, for opening the Settings editor on it.
 *
 * The sidebar has no form of its own for these: they are ordinary VS Code
 * settings, and the Settings editor already gives them their descriptions, the
 * user/workspace tabs and the "also set elsewhere" markers. A QuickPick form
 * can only re-implement that, worse and behind extra clicks.
 */
export function subagentSettingId(): string {
  return SECTION;
}

