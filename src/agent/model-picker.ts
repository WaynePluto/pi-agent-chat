import * as vscode from "vscode";
import type { ModelCatalog } from "../shared/protocol.js";
import { t, tf } from "./i18n.js";
import type { PiRuntime } from "./runtime.js";

/**
 * Model selection, split over two surfaces.
 *
 * - The composer chip opens a small webview menu (`webview/picker.ts`) that
 *   switches between the frequently used models. It is a quick switcher: a
 *   native QuickPick opens at the top of the window, far from the chip that
 *   was clicked, which is exactly what that menu avoids.
 * - "Other models" in that menu opens the full native picker below: every
 *   authenticated model with its capabilities, plus the ⭐ (frequently used)
 *   and 📌 (startup default) row actions.
 *
 * Both mirror the CLI: the frequently used ("scoped") models come first, and
 * `/scoped-models` batch-edits that list. Everything is stored in the shared
 * `enabledModels` setting in `~/.pi/agent/settings.json`, so the sidebar and
 * the terminal agree on what is frequently used.
 */

export interface ModelPickerUi {
  /** Start the provider sign-in flow (offered when nothing is authenticated). */
  login(): Promise<void>;
  /** Push a one-line notice into the transcript. */
  status(text: string): void;
}

type AvailableModel = Awaited<ReturnType<PiRuntime["getAvailableModels"]>>[number];

/** Canonical `provider/modelId` reference, the format persisted by the CLI. */
function modelRef(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Models for the composer's quick menu: exactly the frequently used
 * ("scoped") ones, in their configured order — which is also the CLI's Ctrl+P
 * cycling order. When nothing is scoped the menu stays empty on purpose: the
 * full catalogue belongs in the native picker, not in a small popup.
 */
export async function buildModelCatalog(runtime: PiRuntime): Promise<ModelCatalog> {
  return { items: runtime.scopedModels.map(({ model }) => ({ provider: model.provider, id: model.id })) };
}

/** QuickInputButton extension carrying which per-row action was clicked. */
type ModelActionButton = vscode.QuickInputButton & { action?: "toggle-favorite" };

/** Per-row button that pins a model as the startup default. Built lazily: the
 * headless smoke test loads this module without a real `vscode` runtime. */
let setDefaultButton: vscode.QuickInputButton | undefined;
function getSetDefaultButton(): vscode.QuickInputButton {
  setDefaultButton ??= { iconPath: new vscode.ThemeIcon("pin"), tooltip: t("setDefaultModel") };
  return setDefaultButton;
}

/** Per-row button that adds or removes a model from the frequently used group. */
const favoriteButtons: Record<"add" | "remove", ModelActionButton | undefined> = {
  add: undefined,
  remove: undefined,
};
function getFavoriteButton(favorite: boolean): ModelActionButton {
  const key = favorite ? "remove" : "add";
  favoriteButtons[key] ??= {
    iconPath: new vscode.ThemeIcon(favorite ? "star-full" : "star-empty"),
    tooltip: favorite ? t("removeFavoriteModel") : t("addFavoriteModel"),
    action: "toggle-favorite",
  };
  return favoriteButtons[key];
}

type ModelItem = vscode.QuickPickItem & { model?: AvailableModel };

/** Build the picker rows: favorite group first, then all providers. */
function buildModelItems(runtime: PiRuntime, models: AvailableModel[]): ModelItem[] {
  const current = runtime.session.model as { id?: string; provider?: string } | undefined;
  const settings = runtime.settingsManager;
  const defaultRef =
    settings.getDefaultProvider() && settings.getDefaultModel()
      ? `${settings.getDefaultProvider()}/${settings.getDefaultModel()}`
      : undefined;
  const scopedRefs = runtime.scopedModels.map((scoped) => modelRef(scoped.model));
  const scopedSet = new Set(scopedRefs);
  // Subscription status is per provider; resolve each one once per render.
  const subscriptionByProvider = new Map<string, boolean>();
  const isSubscription = (provider: string): boolean => {
    let known = subscriptionByProvider.get(provider);
    if (known === undefined) {
      known = runtime.isSubscriptionProvider(provider);
      subscriptionByProvider.set(provider, known);
    }
    return known;
  };

  // Grouping is also the only way to add vertical breathing room: QuickPick row
  // height is fixed, separators are the one spacing primitive.
  const items: ModelItem[] = [];
  const row = (model: AvailableModel): ModelItem => {
    const isCurrent = model.id === current?.id && model.provider === current?.provider;
    const isDefault = modelRef(model) === defaultRef;
    const isFavorite = scopedSet.has(modelRef(model));
    // Separators disappear while filtering, so each row carries its provider,
    // plus the markers that tell the user how this model is paid for.
    const description = [
      model.provider,
      isSubscription(model.provider) ? t("subscriptionLabel") : undefined,
      isDefault ? t("defaultModelMarker") : undefined,
    ]
      .filter(Boolean)
      .join(" \u00b7 ");
    return {
      label: `${isCurrent ? "$(check) " : ""}${model.id}`,
      description,
      detail: describeModel(model),
      // Show the favorite star even while the model is the default; hiding it
      // would also remove the only direct way to unfavorite that model.
      buttons: [getFavoriteButton(isFavorite), ...(isDefault ? [] : [getSetDefaultButton()])],
      model,
    };
  };

  if (scopedSet.size > 0) {
    items.push({ label: t("favoriteModels"), kind: vscode.QuickPickItemKind.Separator });
    // Keep the configured order: it is also the CLI's Ctrl+P cycling order.
    for (const reference of scopedRefs) {
      const model = models.find((candidate) => modelRef(candidate) === reference);
      if (model) items.push(row(model));
    }
  }

  const rest = models.filter((model) => !scopedSet.has(modelRef(model)));
  const byProvider = new Map<string, AvailableModel[]>();
  for (const model of rest) {
    const list = byProvider.get(model.provider) ?? [];
    list.push(model);
    byProvider.set(model.provider, list);
  }
  for (const [provider, list] of byProvider) {
    items.push({ label: provider, kind: vscode.QuickPickItemKind.Separator });
    for (const model of list) items.push(row(model));
  }
  return items;
}

/**
 * Show the full model picker and apply the choice.
 *
 * Returns `true` when the active model changed. Per-row actions stay inside
 * the picker: the star toggles the frequently used group, and the pin writes
 * the startup default without closing the picker, mirroring the CLI selector's
 * Ctrl+S.
 */
export async function pickModel(runtime: PiRuntime, ui: ModelPickerUi): Promise<boolean> {
  const models = await loadModels(runtime, ui);
  if (!models) return false;

  const quickPick = vscode.window.createQuickPick<ModelItem>();
  quickPick.title = t("selectModelTitle");
  quickPick.matchOnDescription = true;
  quickPick.matchOnDetail = true;
  quickPick.items = buildModelItems(runtime, models);

  const picked = await new Promise<ModelItem | undefined>((resolve) => {
    quickPick.onDidTriggerItemButton(async (event) => {
      const model = event.item.model;
      if (!model) return;
      const action = (event.button as ModelActionButton).action;
      if (action === "toggle-favorite") {
        const update = await toggleFavoriteModel(runtime, model, models.length);
        ui.status(update === "cleared" ? t("favoriteModelsCleared") : tf("favoriteModelSet", modelRef(model), update === "added"));
      } else {
        await runtime.setDefaultModel(model.provider, model.id);
        ui.status(tf("defaultModelSet", modelRef(model)));
      }
      // Re-render so the star/default markers move to the new state.
      quickPick.items = buildModelItems(runtime, models);
    });
    quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
    quickPick.onDidHide(() => resolve(undefined));
    quickPick.show();
  });
  quickPick.dispose();

  if (!picked) return false;
  if (!picked.model) return false;
  await runtime.setModel(picked.model.provider, picked.model.id);
  return true;
}

/** Result of one direct frequently-used-model change. */
type FavoriteUpdate = "added" | "removed" | "cleared";

/**
 * Toggle one model in the shared frequently used list.
 *
 * Like `/scoped-models`, this stores an explicit `provider/modelId` list. If a
 * user previously configured a wildcard, its currently resolved models become
 * explicit entries on the first star interaction. Selecting every model or no
 * model clears `enabledModels`, which is the CLI's no-filter representation.
 */
async function toggleFavoriteModel(
  runtime: PiRuntime,
  model: AvailableModel,
  totalModels: number,
): Promise<FavoriteUpdate> {
  const reference = modelRef(model);
  const favorites = [...new Set(runtime.scopedModels.map((scoped) => modelRef(scoped.model)))];
  const isFavorite = favorites.includes(reference);
  const next = isFavorite ? favorites.filter((item) => item !== reference) : [...favorites, reference];
  const clears = next.length === 0 || next.length === totalModels;
  await runtime.setEnabledModels(clears ? undefined : next);
  return clears ? "cleared" : isFavorite ? "removed" : "added";
}

/**
 * `/scoped-models`: pick the frequently used models and persist them.
 *
 * Like the CLI selector, the saved value is an explicit `provider/modelId`
 * list (any wildcard patterns previously written by hand are replaced), and
 * selecting all or none clears the setting.
 */
export async function manageScopedModels(runtime: PiRuntime, ui: ModelPickerUi): Promise<void> {
  const models = await loadModels(runtime, ui);
  if (!models) return;

  const enabled = new Set(runtime.scopedModels.map((scoped) => modelRef(scoped.model)));
  type ModelItem = vscode.QuickPickItem & { model?: AvailableModel };
  const items: ModelItem[] = [];
  const byProvider = new Map<string, AvailableModel[]>();
  for (const model of models) {
    const list = byProvider.get(model.provider) ?? [];
    list.push(model);
    byProvider.set(model.provider, list);
  }
  for (const [provider, list] of byProvider) {
    items.push({ label: provider, kind: vscode.QuickPickItemKind.Separator });
    for (const model of list) {
      items.push({
        label: model.id,
        description: model.provider,
        detail: describeModel(model),
        picked: enabled.has(modelRef(model)),
        model,
      });
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: t("favoriteModelsTitle"),
    placeHolder: t("favoriteModelsPlaceholder"),
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  const selected = picked.filter((item) => item.model).map((item) => modelRef(item.model!));
  // "All" and "none" both mean "no scoping" — same rule as the CLI selector.
  const clears = selected.length === 0 || selected.length === models.length;
  await runtime.setEnabledModels(clears ? undefined : selected);
  ui.status(clears ? t("favoriteModelsCleared") : tf("favoriteModelsSaved", selected.length));
}

/** Authenticated models, or `undefined` after offering sign-in when there are none. */
async function loadModels(runtime: PiRuntime, ui: ModelPickerUi): Promise<AvailableModel[] | undefined> {
  const models = (await runtime.getAvailableModels()) as AvailableModel[];
  if (models.length > 0) return models;
  const signIn = t("signInAction");
  const answer = await vscode.window.showWarningMessage(t("noAuthenticatedModel"), signIn);
  if (answer === signIn) await ui.login();
  return undefined;
}

/**
 * QuickPick detail line for one model: input modalities (text / image),
 * context window, max output tokens, plus a reasoning marker when supported.
 */
function describeModel(model: {
  input?: readonly string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}): string {
  const modalities = (model.input ?? [])
    .map((kind) => (kind === "image" ? t("modalityImage") : kind === "text" ? t("modalityText") : kind))
    .join(" + ");
  const detail = tf(
    "modelCapabilities",
    modalities || "-",
    formatTokens(model.contextWindow),
    formatTokens(model.maxTokens),
  );
  return model.reasoning ? `${detail} · ${t("modelReasoning")}` : detail;
}

/** 200000 -> "200K", 1000000 -> "1M"; unknown values render as "?". */
function formatTokens(value?: number): string {
  if (!value || !Number.isFinite(value) || value <= 0) return "?";
  if (value >= 1_000_000) return `${trimZero(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimZero(value / 1_000)}K`;
  return String(value);
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
