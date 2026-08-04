import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import type { PiRuntime } from "./runtime.js";
import { t, tf } from "./i18n.js";

/**
 * The header "Settings" menu: a QuickPick over Pi settings that make sense in
 * the sidebar. Everything writes through the SDK's SettingsManager into
 * `~/.pi/agent/settings.json`, so changes are shared with the pi CLI.
 */

export interface SettingsMenuUi {
  login(): Promise<void>;
  status(text: string): void;
  /** Show the built-in command directory (the /help text). */
  help(): void;
}

export async function openSettingsMenu(runtime: PiRuntime, ui: SettingsMenuUi): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      { id: "providers", label: t("settingsProviders"), description: t("settingsProvidersDetail") },
      { id: "shellPath", label: t("settingsShellPath"), description: t("settingsShellPathDetail") },
      { id: "help", label: t("settingsHelp"), description: t("settingsHelpDetail") },
    ],
    { title: t("settingsTitle") },
  );
  if (!picked) return;
  if (picked.id === "providers") await ui.login();
  else if (picked.id === "shellPath") await pickShellPath(runtime, ui, "");
  else if (picked.id === "help") ui.help();
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
 * Configure `shellPath`. With a non-empty `argument` (from `/shell-path <p>`)
 * the path is validated and set directly; otherwise a QuickPick lists detected
 * shells plus manual entry and reset-to-default.
 */
export async function pickShellPath(runtime: PiRuntime, ui: SettingsMenuUi, argument: string): Promise<void> {
  const settings = runtime.session.settingsManager;
  const current = settings.getShellPath();

  if (argument) {
    const applied = await applyShellPath(settings, argument);
    if (applied) ui.status(tf("shellPathSet", argument));
    return;
  }

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
