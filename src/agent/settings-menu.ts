import { promises as fs } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PiRuntime } from "./runtime.js";
import { configureHttpDispatcher } from "./http.js";
import { openSubagentSettings } from "./subagent-settings.js";
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
  /** Show the built-in command directory (the /help text). */
  help(): void;
  /** Maintain the frequently used model list (`/scoped-models`). */
  manageScopedModels(): Promise<void>;
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
      { id: "providers", label: t("settingsProviders"), description: t("settingsProvidersDetail") },
      { id: "scopedModels", label: t("settingsScopedModels"), description: t("settingsScopedModelsDetail") },
      { id: "subagent", label: t("settingsSubagent"), description: t("settingsSubagentDetail") },
      { id: "shellPath", label: t("settingsShellPath"), description: t("settingsShellPathDetail") },
      { id: "openFile", label: t("settingsOpenFile"), description: t("settingsOpenFileDetail") },
      { id: "help", label: t("settingsHelp"), description: t("settingsHelpDetail") },
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
    if (picked.id === "scopedModels") return void (await ui.manageScopedModels());
    if (picked.id === "shellPath") return void (await pickShellPath(runtime, ui));
    // The subagent form is a submenu of its own, so returning here would close
    // two levels at once; fall through to redraw this menu instead — unless it
    // sent the user to the Settings editor, which this menu would cover.
    if (picked.id === "subagent") {
      if ((await openSubagentSettings(runtime, ui)) === "navigated") return;
      continue;
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
async function pickShellPath(runtime: PiRuntime, ui: Pick<SettingsMenuUi, "status">): Promise<void> {
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
}

interface ShellPathSettings {
  setShellPath(path: string | undefined): void;
}

async function applyShellPath(settings: ShellPathSettings, path: string): Promise<boolean> {
  try {
    await fs.access(path.replace(/^~(?=[/\\])/, process.env.HOME ?? process.env.USERPROFILE ?? "~"));
  } catch {
    vscode.window.showWarningMessage(t("shellPathNotFound"));
    return false;
  }
  settings.setShellPath(path);
  return true;
}
