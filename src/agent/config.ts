import * as vscode from "vscode";
import { CONTENT_WIDTH_MIN, DEFAULT_CONTENT_MAX_WIDTH, DEFAULT_FOLD_LINES, DEFAULT_WIDE_THRESHOLD, WIDE_THRESHOLD_MIN } from "../shared/protocol.js";

/**
 * The plugin's own VS Code settings.
 *
 * Only capabilities that exist *solely* in this host belong here. Anything the
 * CLI also has stays in the shared `~/.pi/agent/` config, so a single settings
 * file cannot make the two hosts behave differently. See AGENTS.md, "配置项归属".
 *
 * The subagent and terminal settings are read per resource (workspace
 * folder), because whether a repository tolerates parallel writing agents — or
 * a tool that runs commands in a visible shell — is a property of the
 * repository, not of the user; the transcript fold threshold below is a pure
 * user preference and is window-scoped instead.
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
 * Top-level section prefix for every setting this plugin contributes, for
 * opening the Settings editor with the full plugin scope visible (subagent,
 * terminal tool, transcript folding, …).
 *
 * This is the *only* deep link the sidebar offers: the settings have no form of
 * their own here, because they are ordinary VS Code settings and the Settings
 * editor already gives them their descriptions, the user/workspace tabs and the
 * "also set elsewhere" markers. Per-feature entries were dropped as well — one
 * search field over the whole plugin scope beats several menu rows that each
 * land one filter narrower.
 */
export function pluginSettingId(): string {
  return "piAgentChat";
}

/* -- Integrated terminal ------------------------------------------------ */

const TERMINAL_SECTION = "piAgentChat.terminal";

/**
 * Ceiling on how many terminals the tool may keep open, enforced here as well
 * as in `package.json` (whose `maximum` only constrains the settings UI).
 *
 * Terminals are a visible, shared surface: past a handful of them the terminal
 * panel is no longer something the user can follow, and "a terminal you can
 * watch and type into" — the entire reason this tool exists in a host that
 * already has `bash` — stops being true.
 */
export const TERMINAL_HARD_CAP = 8;

export interface TerminalConfig {
  /** Whether to offer the tool at all. Off unless the user opted in. */
  readonly enabled: boolean;
  /** How many terminals may be open at once. */
  readonly maxTerminals: number;
}

/**
 * Read the current terminal-tool configuration for a working directory.
 *
 * Same timing rule as {@link readSubagentConfig}: called when a session's tool
 * set is built, because that is when a changed setting can land.
 *
 * `enabled` is a separate boolean from the count on purpose, rather than
 * folding "off" into `maxTerminals: 0`. The two answer different questions —
 * whether the capability exists at all (the model does not even see the tool)
 * versus how an existing capability behaves — and merging them would lose the
 * user's tuned value every time they switch the feature off and on, contradict
 * the `minimum: 1` validation, and hand `0` a meaning opposite to the "no
 * limit" it carries in most tools.
 */
export function readTerminalConfig(cwd: string): TerminalConfig {
  const config = vscode.workspace.getConfiguration(TERMINAL_SECTION, vscode.Uri.file(cwd));
  return {
    enabled: config.get<boolean>("enabled") ?? false,
    maxTerminals: clampTerminalLimit(config.get<number>("maxTerminals") ?? 3),
  };
}

/** Round and clamp a configured count into a usable number of terminals. */
export function clampTerminalLimit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(TERMINAL_HARD_CAP, Math.max(1, Math.round(value)));
}

/** Whether a settings change event touches the terminal tool's settings. */
export function affectsTerminalConfig(event: vscode.ConfigurationChangeEvent, cwd: string): boolean {
  return event.affectsConfiguration(TERMINAL_SECTION, vscode.Uri.file(cwd));
}

/* -- Wide layout --------------------------------------------------------- */

const LAYOUT_SECTION = "piAgentChat.layout";

/**
 * Max width in pixels of the centered message area (transcript and composer).
 *
 * The manifest's `minimum` only constrains the settings UI, so the clamp is
 * repeated here for hand-edited `settings.json` values. There is no ceiling:
 * the setting means only what its name says, and a very wide display is not a
 * mistake to be corrected. When wide mode begins is a separate setting
 * ({@link readWideThreshold}) precisely so that widening the transcript does
 * not also push the rails further away.
 */
export function readContentMaxWidth(): number {
  const raw = vscode.workspace.getConfiguration(LAYOUT_SECTION).get<number>("contentMaxWidth");
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_CONTENT_MAX_WIDTH;
  return Math.max(CONTENT_WIDTH_MIN, Math.round(raw));
}

/**
 * Webview width at which the three-column layout becomes available.
 *
 * Clamped to {@link WIDE_THRESHOLD_MIN} rather than trusted: below that the
 * three columns cannot all satisfy their minimums, so a hand-edited value would
 * switch the layout into a shape it cannot honour. Crossing the threshold does
 * not open a rail by itself, so lowering it is cheap.
 */
export function readWideThreshold(): number {
  const raw = vscode.workspace.getConfiguration(LAYOUT_SECTION).get<number>("wideModeMinWidth");
  if (raw === undefined || !Number.isFinite(raw)) return Math.max(WIDE_THRESHOLD_MIN, DEFAULT_WIDE_THRESHOLD);
  return Math.max(WIDE_THRESHOLD_MIN, Math.round(raw));
}

/** Whether a settings change event touches either wide-layout geometry value. */
export function affectsLayoutConfig(event: vscode.ConfigurationChangeEvent): boolean {
  return (
    event.affectsConfiguration(`${LAYOUT_SECTION}.contentMaxWidth`) ||
    event.affectsConfiguration(`${LAYOUT_SECTION}.wideModeMinWidth`)
  );
}

/* -- Message folding ----------------------------------------------------- */

const TRANSCRIPT_SECTION = "piAgentChat.transcript";

/**
 * Line threshold at which a message bubble may fold to a preview. A pure
 * presentation preference of this host, so it lives here rather than in the
 * shared `~/.pi/agent/` config. `0` means "never fold"; anything not a usable
 * number falls back to the documented default rather than silently disabling
 * the feature.
 */
export function readFoldLines(): number {
  const raw = vscode.workspace.getConfiguration(TRANSCRIPT_SECTION).get<number>("foldLines");
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_FOLD_LINES;
  return Math.max(0, Math.round(raw));
}

/** Whether a settings change event touches the fold threshold. */
export function affectsFoldConfig(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(`${TRANSCRIPT_SECTION}.foldLines`);
}

