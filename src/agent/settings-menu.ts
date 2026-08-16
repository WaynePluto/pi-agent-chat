import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { applyEdits, modify } from "jsonc-parser";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PiRuntime } from "./runtime.js";
import { configureHttpDispatcher } from "./http.js";
import { subagentSettingId } from "./config.js";
import { t, tf } from "./i18n.js";

/**
 * The header "Settings" menu: a QuickPick over Pi settings that make sense in
 * the sidebar. Everything writes through the SDK's SettingsManager into
 * `~/.pi/agent/settings.json`, so changes are shared with the pi CLI.
 *
 * Terminal-only display settings (theme, image rendering, paddings, cursor,
 * startup verbosity) are deliberately not offered here.
 */

export interface SettingsMenuUi {
  login(): Promise<void>;
  status(text: string): void;
  /** Rejections and validation failures, in the transcript like `status`. */
  error(text: string): void;
  /** Show the built-in command directory (the /help text). */
  help(): void;
  /** Maintain the frequently used model list (`/scoped-models`). */
  manageScopedModels(): Promise<void>;
  /** Re-fetch every provider's model catalogue from the network. */
  refreshModels(): Promise<void>;
  /** The slash command catalogue changed (e.g. skill commands toggled). */
  commandsChanged?(): void;
}

/** One selectable value of an enum-ish setting. */
interface SettingChoice {
  value: string;
  label: string;
  description?: string;
}

/**
 * A settings entry backed by a `SettingsManager` getter/setter pair.
 * Booleans are modelled as two-choice enums so one submenu serves all.
 */
interface SettingDescriptor {
  id: string;
  label: string;
  detail: string;
  choices: SettingChoice[];
  get(runtime: PiRuntime): string;
  set(runtime: PiRuntime, value: string): void;
  /** Slash command autocomplete must be re-posted after this changes. */
  affectsCommands?: boolean;
  /** Side effect to run once the new value has been persisted. */
  apply?(runtime: PiRuntime): void;
}

const ON_OFF: SettingChoice[] = [
  { value: "true", label: "on" },
  { value: "false", label: "off" },
];

const QUEUE_MODES: SettingChoice[] = [
  { value: "one-at-a-time", label: "one-at-a-time" },
  { value: "all", label: "all" },
];

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** SDK-MIRROR: `HTTP_IDLE_TIMEOUT_CHOICES` in `core/http-dispatcher.ts`. */
const HTTP_IDLE_TIMEOUTS: SettingChoice[] = [
  { value: "30000", label: "30 sec" },
  { value: "60000", label: "1 min" },
  { value: "120000", label: "2 min" },
  { value: "300000", label: "5 min" },
  { value: "0", label: "disabled" },
];

/**
 * The offered settings. Labels/details resolve through `t()` lazily so the
 * table itself stays declarative.
 */
function settingDescriptors(): SettingDescriptor[] {
  const bool = (get: (r: PiRuntime) => boolean, set: (r: PiRuntime, v: boolean) => void) => ({
    choices: ON_OFF,
    get: (r: PiRuntime) => String(get(r)),
    set: (r: PiRuntime, v: string) => set(r, v === "true"),
  });
  return [
    {
      id: "autoCompact",
      label: t("settingAutoCompact"),
      detail: t("settingAutoCompactDetail"),
      ...bool(
        (r) => r.settingsManager.getCompactionEnabled(),
        // Persists through the session so the running agent also picks it up.
        (r, v) => r.session.setAutoCompactionEnabled(v),
      ),
    },
    {
      id: "defaultThinkingLevel",
      label: t("settingDefaultThinking"),
      detail: t("settingDefaultThinkingDetail"),
      choices: THINKING_LEVELS.map((level) => ({ value: level, label: level })),
      get: (r) => r.settingsManager.getDefaultThinkingLevel() ?? "off",
      set: (r, v) => r.settingsManager.setDefaultThinkingLevel(v as (typeof THINKING_LEVELS)[number]),
    },
    {
      id: "steeringMode",
      label: t("settingSteeringMode"),
      detail: t("settingSteeringModeDetail"),
      choices: QUEUE_MODES,
      get: (r) => r.settingsManager.getSteeringMode(),
      set: (r, v) => r.session.setSteeringMode(v as "all" | "one-at-a-time"),
    },
    {
      id: "followUpMode",
      label: t("settingFollowUpMode"),
      detail: t("settingFollowUpModeDetail"),
      choices: QUEUE_MODES,
      get: (r) => r.settingsManager.getFollowUpMode(),
      set: (r, v) => r.session.setFollowUpMode(v as "all" | "one-at-a-time"),
    },
    {
      id: "defaultProjectTrust",
      label: t("settingProjectTrust"),
      detail: t("settingProjectTrustDetail"),
      choices: [
        { value: "ask", label: t("trustAsk") },
        { value: "always", label: t("trustAlways") },
        { value: "never", label: t("trustNever") },
      ],
      get: (r) => r.settingsManager.getDefaultProjectTrust(),
      set: (r, v) => r.settingsManager.setDefaultProjectTrust(v as "ask" | "always" | "never"),
    },
    {
      id: "skillCommands",
      label: t("settingSkillCommands"),
      detail: t("settingSkillCommandsDetail"),
      affectsCommands: true,
      ...bool(
        (r) => r.settingsManager.getEnableSkillCommands(),
        (r, v) => r.settingsManager.setEnableSkillCommands(v),
      ),
    },
    {
      id: "retry",
      label: t("settingRetry"),
      detail: t("settingRetryDetail"),
      ...bool(
        (r) => r.settingsManager.getRetryEnabled(),
        (r, v) => r.settingsManager.setRetryEnabled(v),
      ),
    },
    {
      id: "transport",
      label: t("settingTransport"),
      detail: t("settingTransportDetail"),
      choices: ["auto", "sse", "websocket", "websocket-cached"].map((v) => ({ value: v, label: v })),
      get: (r) => r.settingsManager.getTransport(),
      set: (r, v) => r.settingsManager.setTransport(v as "auto" | "sse" | "websocket" | "websocket-cached"),
    },
    {
      id: "httpIdleTimeout",
      label: t("settingHttpIdleTimeout"),
      detail: t("settingHttpIdleTimeoutDetail"),
      choices: HTTP_IDLE_TIMEOUTS,
      get: (r) => String(r.settingsManager.getHttpIdleTimeoutMs()),
      set: (r, v) => r.settingsManager.setHttpIdleTimeoutMs(Number(v)),
      // The dispatcher captures the timeout at construction, so rebuild it
      // the way the CLI's settings selector does.
      apply: (r) => configureHttpDispatcher(r.settingsManager.getHttpIdleTimeoutMs()),
    },
    {
      id: "autoResizeImages",
      label: t("settingAutoResizeImages"),
      detail: t("settingAutoResizeImagesDetail"),
      ...bool(
        (r) => r.settingsManager.getImageAutoResize(),
        (r, v) => r.settingsManager.setImageAutoResize(v),
      ),
    },
    {
      id: "blockImages",
      label: t("settingBlockImages"),
      detail: t("settingBlockImagesDetail"),
      ...bool(
        (r) => r.settingsManager.getBlockImages(),
        (r, v) => r.settingsManager.setBlockImages(v),
      ),
    },
    {
      id: "anthropicExtraUsageWarning",
      label: t("settingAnthropicWarning"),
      detail: t("settingAnthropicWarningDetail"),
      ...bool(
        (r) => r.settingsManager.getWarnings().anthropicExtraUsage ?? true,
        (r, v) => r.settingsManager.setWarnings({ ...r.settingsManager.getWarnings(), anthropicExtraUsage: v }),
      ),
    },
  ];
}

function choiceLabel(descriptor: SettingDescriptor, value: string): string {
  return descriptor.choices.find((choice) => choice.value === value)?.label ?? value;
}

export async function openSettingsMenu(runtime: PiRuntime, ui: SettingsMenuUi): Promise<void> {
  type Item = vscode.QuickPickItem & { id: string; descriptor?: SettingDescriptor };
  // Loop so several settings can be changed in one visit, like the CLI list.
  for (;;) {
    const descriptors = settingDescriptors();
    const items: Item[] = [
      { id: "providers", label: t("settingsProviders"), detail: t("settingsProvidersDetail") },
      { id: "refreshModels", label: t("settingsRefreshModels"), detail: t("settingsRefreshModelsDetail") },
      { id: "scopedModels", label: t("settingsScopedModels"), detail: t("settingsScopedModelsDetail") },
      {
        id: "defaultTools",
        label: t("settingsDefaultTools"),
        description: defaultToolsSummary(runtime),
        detail: t("settingsDefaultToolsDetail"),
      },
      { id: "subagent", label: t("settingsSubagent"), detail: t("settingsSubagentDetail") },
      { id: "shellPath", label: t("settingsShellPath"), detail: t("settingsShellPathDetail") },
      { id: "openFile", label: t("settingsOpenFile"), detail: t("settingsOpenFileDetail") },
      { id: "help", label: t("settingsHelp"), detail: t("settingsHelpDetail") },
      { id: "", label: t("settingsSectionOptions"), kind: vscode.QuickPickItemKind.Separator },
      ...descriptors.map((descriptor) => ({
        id: descriptor.id,
        descriptor,
        label: descriptor.label,
        description: choiceLabel(descriptor, descriptor.get(runtime)),
        detail: descriptor.detail,
      })),
    ];
    const picked = await vscode.window.showQuickPick(items, { title: t("settingsTitle"), matchOnDetail: true });
    if (!picked) return;
    if (picked.id === "providers") return void (await ui.login());
    if (picked.id === "refreshModels") return void (await ui.refreshModels());
    if (picked.id === "scopedModels") return void (await ui.manageScopedModels());
    if (picked.id === "defaultTools") return void (await manageDefaultTools(runtime, ui));
    if (picked.id === "shellPath") return void (await pickShellPath(runtime, ui));
    // The subagent switches are this host's own VS Code settings, so the
    // Settings editor is where they belong: it already renders their
    // descriptions, the workspace/user tabs and the "modified elsewhere"
    // markers that a QuickPick form can only re-implement badly. Return rather
    // than redraw — this menu would cover what the user just asked to see.
    if (picked.id === "subagent") {
      await vscode.commands.executeCommand("workbench.action.openSettings", subagentSettingId());
      return;
    }
    if (picked.id === "help") return ui.help();
    if (picked.id === "openFile") return void (await openSettingsFile());
    if (picked.descriptor) await editSetting(runtime, ui, picked.descriptor);
  }
}

/** Submenu for one setting: pick a value, persist it, report to transcript. */
async function editSetting(runtime: PiRuntime, ui: SettingsMenuUi, descriptor: SettingDescriptor): Promise<void> {
  const current = descriptor.get(runtime);
  const picked = await vscode.window.showQuickPick(
    descriptor.choices.map((choice) => ({
      label: `${choice.value === current ? "$(check) " : ""}${choice.label}`,
      description: choice.value === current ? t("current") : undefined,
      value: choice.value,
    })),
    { title: descriptor.label, placeHolder: descriptor.detail },
  );
  if (!picked || picked.value === current) return;
  descriptor.set(runtime, picked.value);
  await runtime.settingsManager.flush();
  descriptor.apply?.(runtime);
  ui.status(tf("settingChanged", descriptor.label, choiceLabel(descriptor, picked.value)));
  if (descriptor.affectsCommands) ui.commandsChanged?.();
}

/**
 * The built-in tools a fresh session starts with — the SDK's fixed set
 * (`defaultActiveToolNames` in `core/sdk.ts`). Extension and SDK custom tools
 * are not listed: `defaultTools` never gates them.
 */
const BUILTIN_TOOLS = ["read", "bash", "edit", "write"] as const;

const TOOL_DESCRIPTIONS: Record<(typeof BUILTIN_TOOLS)[number], keyof typeof import("../shared/messages.js").sharedMessages> = {
  read: "toolDescRead",
  bash: "toolDescBash",
  edit: "toolDescEdit",
  write: "toolDescWrite",
};

/**
 * Menu-row summary of the effective `defaultTools`, marking a workspace
 * override (the marker is what tells the two scopes apart at a glance).
 */
function defaultToolsSummary(runtime: PiRuntime): string {
  const summary = toolSetSummary(runtime.settingsManager.getDefaultTools());
  return runtime.settingsManager.getProjectSettings().defaultTools ? `${summary} (${t("defaultToolsWorkspace")})` : summary;
}

/** One-line summary of one scope's explicit value (`undefined` = all, default). */
function toolSetSummary(tools: string[] | undefined): string {
  if (tools === undefined) return t("defaultToolsAll");
  if (tools.length === 0) return t("defaultToolsNone");
  return tools.join(", ");
}

/**
 * `defaultTools` multi-select, in the spirit of `/scoped-models`.
 *
 * The setting is shared with the pi CLI and has two scopes: the user scope
 * writes `~/.pi/agent/settings.json`, the workspace scope writes
 * `<cwd>/.pi/settings.json` and overrides it there — the SDK's
 * SettingsManager deep-merges project over global, and the CLI reads the same
 * two files, so neither host drifts.
 *
 * The SDK reads the setting when a session is constructed but offers no
 * setter (the CLI leaves it to hand edits of settings.json), so the picked
 * value is written the same way a hand edit would be — jsonc `modify()` +
 * WorkspaceEdit keeps comments and an open editor in sync — followed by
 * `settingsManager.reload()` so the running host agrees with the file.
 * Running sessions keep the tools they were built with; the new set takes
 * effect on the next session construction.
 *
 * Scope-specific save semantics:
 * - User: checking all four restores the default, so the key is removed;
 *   checking none is a real configuration (no built-in tools) and writes `[]`.
 * - Workspace: the explicit list is always written — even all four, so a
 *   workspace can pin its tools against later user-scope changes. Removing
 *   the override is its own "reset" entry: the key is deleted and the
 *   workspace follows the user setting again.
 */
async function manageDefaultTools(runtime: PiRuntime, ui: Pick<SettingsMenuUi, "status">): Promise<void> {
  const settings = runtime.settingsManager;
  const globalTools = settings.getGlobalSettings().defaultTools;
  const projectTools = settings.getProjectSettings().defaultTools;
  const workspacePath = join(runtime.cwd, CONFIG_DIR_NAME, "settings.json");

  type ScopeItem = vscode.QuickPickItem & { scope: "user" | "workspace" | "reset" };
  const items: ScopeItem[] = [
    {
      scope: "user",
      label: t("defaultToolsScopeUser"),
      description: toolSetSummary(globalTools),
      detail: t("defaultToolsScopeUserDetail"),
    },
    {
      scope: "workspace",
      label: t("defaultToolsScopeWorkspace"),
      description: projectTools ? toolSetSummary(projectTools) : t("defaultToolsWorkspaceNotSet"),
      detail: tf("defaultToolsScopeWorkspaceDetail", workspacePath),
    },
  ];
  if (projectTools) {
    items.push({
      scope: "reset",
      label: t("defaultToolsResetWorkspace"),
      detail: tf("defaultToolsResetDetail", workspacePath),
    });
  }
  const picked = await vscode.window.showQuickPick(items, { title: t("defaultToolsScopeTitle"), matchOnDetail: true });
  if (!picked) return;

  if (picked.scope === "reset") {
    if (!(await persistDefaultTools(workspacePath, undefined))) return;
    await settings.reload();
    ui.status(t("defaultToolsWorkspaceReset"));
    return;
  }

  if (picked.scope === "user") {
    const selected = await pickToolSet(
      t("defaultToolsTitleUser"),
      t("defaultToolsPlaceholder"),
      new Set(globalTools ?? BUILTIN_TOOLS),
    );
    if (!selected) return;
    const value = selected.length === BUILTIN_TOOLS.length ? undefined : selected;
    if (!(await persistDefaultTools(join(getAgentDir(), "settings.json"), value))) return;
  } else {
    const inherited = new Set(globalTools ?? BUILTIN_TOOLS);
    const selected = await pickToolSet(
      t("defaultToolsTitleWorkspace"),
      t("defaultToolsWorkspacePlaceholder"),
      new Set(projectTools ?? inherited),
    );
    if (!selected) return;
    // With no existing override, picking exactly the inherited set would
    // create an override that changes nothing — skip the write.
    if (!projectTools && selected.length === inherited.size && selected.every((tool) => inherited.has(tool))) {
      ui.status(tf("defaultToolsSaved", defaultToolsSummary(runtime)));
      return;
    }
    if (!(await persistDefaultTools(workspacePath, selected))) return;
  }

  await settings.reload();
  ui.status(
    picked.scope === "user"
      ? tf("defaultToolsSaved", defaultToolsSummary(runtime))
      : tf("defaultToolsSavedWorkspace", defaultToolsSummary(runtime)),
  );
}

/** The `defaultTools` checkbox multi-select shared by both scopes. */
async function pickToolSet(
  title: string,
  placeHolder: string,
  active: ReadonlySet<string>,
): Promise<string[] | undefined> {
  const picked = await vscode.window.showQuickPick(
    BUILTIN_TOOLS.map((tool) => ({
      label: tool,
      description: t(TOOL_DESCRIPTIONS[tool]),
      picked: active.has(tool),
    })),
    { title, placeHolder, canPickMany: true },
  );
  if (!picked) return undefined;
  const checked = new Set(picked.map((item) => item.label));
  return BUILTIN_TOOLS.filter((tool) => checked.has(tool));
}

/** Indentation for the structural edit, matching the SDK's own writes. */
const SETTINGS_FORMATTING = { tabSize: 2, insertSpaces: true };

/**
 * Write `defaultTools` into a settings.json (`undefined` removes the key).
 * Returns false when the file cannot be edited — e.g. it is broken JSON, in
 * which case the "Open settings file" menu entry is the fix.
 */
async function persistDefaultTools(path: string, tools: string[] | undefined): Promise<boolean> {
  try {
    await fs.access(path);
  } catch {
    // First write to this file: seed an empty object the way the CLI creates
    // its settings files lazily. The workspace variant may still lack its
    // `<cwd>/.pi` directory.
    await fs.mkdir(dirname(path), { recursive: true }).catch(() => {});
    await fs.writeFile(path, "{}\n", { flag: "wx" }).catch(() => {});
  }
  const uri = vscode.Uri.file(path);
  const document = await vscode.workspace.openTextDocument(uri);
  const text = document.getText();
  const edits = modify(text, ["defaultTools"], tools, { formattingOptions: SETTINGS_FORMATTING });
  // Empty edits: the file already says what was picked (e.g. removing a key
  // that was never set) — nothing to persist, but nothing failed either.
  if (edits.length === 0) return true;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(text.length)), applyEdits(text, edits));
  if (!(await vscode.workspace.applyEdit(edit))) return false;
  return await document.save();
}

/** Open the shared `~/.pi/agent/settings.json` in an editor tab. */
async function openSettingsFile(): Promise<void> {
  const path = join(getAgentDir(), "settings.json");
  try {
    await fs.access(path);
  } catch {
    // First run: the CLI creates the file lazily; create an empty object so
    // the editor does not open a phantom untitled file.
    await fs.writeFile(path, "{}\n", { flag: "wx" }).catch(() => {});
  }
  await vscode.window.showTextDocument(vscode.Uri.file(path));
}

/** Candidate shells probed on this machine; only existing ones are offered. */
const WINDOWS_SHELLS: Array<{ label: string; paths: string[] }> = [
  {
    label: "PowerShell 7 (pwsh)",
    paths: [
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe",
    ],
  },
  {
    label: "Windows PowerShell 5.1",
    paths: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
  },
  {
    label: "Git Bash",
    paths: ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"],
  },
  { label: "cmd", paths: ["C:\\Windows\\System32\\cmd.exe"] },
  { label: "WSL bash", paths: ["C:\\Windows\\System32\\bash.exe"] },
];

const UNIX_SHELLS: Array<{ label: string; paths: string[] }> = [
  { label: "bash", paths: ["/bin/bash", "/usr/bin/bash", "/opt/homebrew/bin/bash"] },
  { label: "zsh", paths: ["/bin/zsh", "/usr/bin/zsh"] },
  { label: "fish", paths: ["/usr/bin/fish", "/opt/homebrew/bin/fish"] },
  { label: "PowerShell (pwsh)", paths: ["/usr/bin/pwsh", "/usr/local/bin/pwsh", "/opt/homebrew/bin/pwsh"] },
];

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

/**
 * Configure `shellPath`: a QuickPick listing detected shells plus manual entry
 * and reset-to-default. Reached from the settings menu.
 */
async function pickShellPath(runtime: PiRuntime, ui: Pick<SettingsMenuUi, "status" | "error">): Promise<void> {
  const settings = runtime.session.settingsManager;
  const current = settings.getShellPath();

  const candidates = process.platform === "win32" ? WINDOWS_SHELLS : UNIX_SHELLS;
  const detected = (
    await Promise.all(
      candidates.map(async (shell) => {
        const path = await firstExisting(shell.paths);
        return path ? { shell, path } : undefined;
      }),
    )
  ).filter((entry): entry is { shell: (typeof candidates)[number]; path: string } => Boolean(entry));

  type Item = vscode.QuickPickItem & { action: "set" | "custom" | "reset"; path?: string };
  const items: Item[] = detected.map(({ shell, path }) => ({
    action: "set",
    path,
    label: shell.label,
    description: path === current ? t("current") : undefined,
    detail: path,
  }));
  items.push({ action: "custom", label: t("shellPathCustom") });
  items.push({ action: "reset", label: t("shellPathDefault"), description: current ? undefined : t("current"), detail: t("shellPathDefaultDetail") });

  const picked = await vscode.window.showQuickPick(items, { title: t("shellPathTitle") });
  if (!picked) return;

  if (picked.action === "reset") {
    settings.setShellPath(undefined);
    ui.status(t("shellPathCleared"));
    return;
  }

  let target = picked.path;
  if (picked.action === "custom") {
    target = (
      await vscode.window.showInputBox({
        title: t("shellPathInputTitle"),
        prompt: t("shellPathInputPrompt"),
        value: current ?? "",
      })
    )?.trim();
  }
  if (!target) return;
  const applied = await applyShellPath(settings, target);
  if (applied) ui.status(tf("shellPathSet", target));
  else ui.error(t("shellPathNotFound"));
}

interface ShellPathSettings {
  setShellPath(path: string | undefined): void;
}

async function applyShellPath(settings: ShellPathSettings, path: string): Promise<boolean> {
  try {
    await fs.access(path.replace(/^~(?=[/\\])/, process.env.HOME ?? process.env.USERPROFILE ?? "~"));
  } catch {
    return false;
  }
  settings.setShellPath(path);
  return true;
}
