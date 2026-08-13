import * as vscode from "vscode";
import {
  SUBAGENT_HARD_CAP,
  hasWorkspaceScope,
  subagentSettingId,
  readSubagentConfig,
  readSubagentOverride,
  writeSubagentSetting,
  type SubagentKey,
  type SettingsScope,
} from "./config.js";
import { describe } from "./errors.js";
import { t, tf } from "./i18n.js";
import type { PiRuntime } from "./runtime.js";

/**
 * The "Subagent" form behind the header settings menu.
 *
 * The `subagent` tool exists only in this host, so its switches live in VS Code
 * settings rather than in the shared `~/.pi/agent/settings.json` (AGENTS.md,
 * "配置项归属"). The one thing a settings file cannot express is *where* a value
 * should go, so the form makes that an explicit first row: everything edited
 * below is written to the chosen scope, workspace or user. Whether a repository
 * tolerates agents writing to it in parallel is a property of the repository,
 * which is exactly why workspace is offered — and preselected — at all.
 *
 * Values are written through the configuration API instead of by editing JSON:
 * VS Code owns the formatting of its settings files, and the write is observed
 * by the chat view's `onDidChangeConfiguration` listener, which is what tells
 * the user the change lands on the next session.
 */

export interface SubagentSettingsUi {
  /** Push a one-line notice into the transcript. */
  status(text: string): void;
}

/**
 * How the form was left, so the caller knows whether to redraw its own menu.
 *
 * "navigated" means the user was sent somewhere else (the Settings editor);
 * re-opening the settings QuickPick on top of it would cover what they just
 * asked to see.
 */
export type SubagentSettingsOutcome = "dismissed" | "navigated";

/** One editable row of the form. */
interface Field {
  key: SubagentKey;
  label: string;
  detail: string;
  /** How the currently effective value reads. */
  value: string;
  /**
   * The effective value in the same shape the choices carry, so the current
   * row can be ticked. Kept apart from `value`, which is for display: "on" is
   * a better label than "true", but only `true` matches a choice.
   */
  current: string;
  /** Value choices, in menu order; `undefined` clears the override. */
  choices(runtime: PiRuntime): Promise<Array<{ label: string; description?: string; value: boolean | number | string | undefined }>>;
}

function scopeLabel(scope: SettingsScope): string {
  return scope === "workspace" ? t("subagentScopeWorkspace") : t("subagentScopeUser");
}

/** Models that can be typed as `provider/modelId`, best effort. */
async function modelChoices(runtime: PiRuntime): Promise<Array<{ label: string; description?: string; value: string }>> {
  try {
    const models = await runtime.getAvailableModels();
    return models.map((model) => ({ label: `${model.provider}/${model.id}`, description: model.provider, value: `${model.provider}/${model.id}` }));
  } catch {
    // Nothing authenticated, or the probe failed: manual entry still works.
    return [];
  }
}

function fields(config: ReturnType<typeof readSubagentConfig>): Field[] {
  return [
    {
      key: "enabled",
      label: t("subagentEnabled"),
      detail: t("subagentEnabledDetail"),
      value: config.enabled ? "on" : "off",
      current: String(config.enabled),
      choices: async () => [
        { label: "on", value: true },
        { label: "off", value: false },
        { label: t("subagentClearOverride"), value: undefined },
      ],
    },
    {
      key: "maxSubagents",
      label: t("subagentMaxSubagents"),
      detail: t("subagentMaxSubagentsDetail"),
      value: String(config.maxSubagents),
      current: String(config.maxSubagents),
      choices: async () => [
        ...Array.from({ length: SUBAGENT_HARD_CAP }, (_, index) => ({ label: String(index + 1), value: index + 1 })),
        { label: t("subagentClearOverride"), value: undefined },
      ],
    },
    {
      key: "defaultModel",
      label: t("subagentDefaultModel"),
      detail: t("subagentDefaultModelDetail"),
      value: config.defaultModel ?? t("subagentInheritModel"),
      current: config.defaultModel ?? "",
      choices: async (runtime) => [
        // Clearing and storing an empty string read back the same, so the
        // inherit option is simply "no value here" rather than a third state.
        { label: t("subagentInheritModel"), value: undefined },
        // Manual entry sits right below it, not after the catalogue: the list
        // only holds authenticated models, so anything else — a model that is
        // configured elsewhere, or one not yet signed in — can only be typed,
        // and that option must not be pushed off the bottom of a long list.
        { label: t("subagentCustomModel"), value: CUSTOM_MODEL },
        ...(await modelChoices(runtime)),
      ],
    },
  ];
}

/** Sentinel choice that opens a free-text input instead of writing a value. */
const CUSTOM_MODEL = "\u0000custom";

export async function openSubagentSettings(runtime: PiRuntime, ui: SubagentSettingsUi): Promise<SubagentSettingsOutcome> {
  const workspaceAvailable = hasWorkspaceScope();
  let scope: SettingsScope = workspaceAvailable ? "workspace" : "user";

  type Item = vscode.QuickPickItem & { id?: "scope" | "open"; field?: Field };
  // Loop so the whole form can be filled in one visit.
  for (;;) {
    const cwd = runtime.cwd;
    const config = readSubagentConfig(cwd);
    const items: Item[] = [
      {
        id: "scope",
        label: `$(gear) ${t("subagentScope")}`,
        description: scopeLabel(scope),
        detail: workspaceAvailable ? t("subagentScopeDetail") : t("subagentScopeNoWorkspace"),
      },
      { label: t("subagentSectionValues"), kind: vscode.QuickPickItemKind.Separator },
      ...fields(config).map((field) => ({
        field,
        label: field.label,
        // The effective value, plus whether it comes from the scope being
        // edited — without that, clearing an override looks like a no-op.
        description: [field.value, overrideSource(cwd, scope, field.key)].filter(Boolean).join(" \u00b7 "),
        detail: field.detail,
      })),
      { label: "", kind: vscode.QuickPickItemKind.Separator },
      { id: "open", label: t("subagentOpenSettingsUi") },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: t("subagentSettingsTitle"),
      placeHolder: t("subagentSettingsHint"),
      matchOnDetail: true,
    });
    if (!picked) return "dismissed";
    if (picked.id === "open") {
      await vscode.commands.executeCommand("workbench.action.openSettings", subagentSettingId());
      return "navigated";
    }
    if (picked.id === "scope") {
      if (!workspaceAvailable) {
        vscode.window.showInformationMessage(t("subagentScopeNoWorkspace"));
        continue;
      }
      scope = (await pickScope(scope)) ?? scope;
      continue;
    }
    if (picked.field) await editField(runtime, ui, scope, picked.field);
  }
}

/** `set in <scope>` when this scope holds an explicit value, else nothing. */
function overrideSource(cwd: string, scope: SettingsScope, key: SubagentKey): string | undefined {
  const stored = readSubagentOverride<unknown>(cwd, scope, key);
  return stored === undefined ? undefined : tf("subagentSettingSource", scopeLabel(scope));
}

async function pickScope(current: SettingsScope): Promise<SettingsScope | undefined> {
  const picked = await vscode.window.showQuickPick(
    (["workspace", "user"] as const).map((scope) => ({
      label: `${scope === current ? "$(check) " : ""}${scopeLabel(scope)}`,
      description: scope === current ? t("current") : undefined,
      scope,
    })),
    { title: t("subagentScope"), placeHolder: t("subagentScopeDetail") },
  );
  return picked?.scope;
}

/** Submenu for one field: pick a value, persist it at `scope`, report it. */
async function editField(runtime: PiRuntime, ui: SubagentSettingsUi, scope: SettingsScope, field: Field): Promise<void> {
  const choices = await field.choices(runtime);
  const picked = await vscode.window.showQuickPick(
    choices.map((choice) => ({
      label: `${String(choice.value ?? "") === field.current ? "$(check) " : ""}${choice.label}`,
      description: choice.description,
      value: choice.value,
    })),
    { title: field.label, placeHolder: field.detail },
  );
  if (!picked) return;

  let value = picked.value;
  if (value === CUSTOM_MODEL) {
    const typed = (
      await vscode.window.showInputBox({
        title: t("subagentModelInputTitle"),
        prompt: t("subagentModelInputPrompt"),
        value: readSubagentOverride<string>(runtime.cwd, scope, "defaultModel") ?? "",
      })
    )?.trim();
    if (typed === undefined) return;
    value = typed || undefined;
  }

  try {
    await writeSubagentSetting(runtime.cwd, scope, field.key, value);
  } catch (error) {
    vscode.window.showWarningMessage(describe(error));
    return;
  }
  const written =
    value === undefined ? t("subagentClearOverride") : typeof value === "boolean" ? (value ? "on" : "off") : String(value);
  ui.status(tf("subagentSettingWritten", field.label, written, scopeLabel(scope)));
}
