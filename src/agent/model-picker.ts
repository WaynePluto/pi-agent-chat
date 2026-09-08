import * as vscode from "vscode";
import type { ModelCatalog } from "../shared/protocol.js";
import { t, tf } from "./i18n.js";
import type { PiRuntime } from "./runtime.js";

/**
 * 模型选择，分两层界面。composer 的 chip 打开小 webview 菜单
 * （`webview/picker.ts`）在常用模型间切换——原生 QuickPick 固定出现在
 * 窗口顶部、离 chip 太远；菜单里的「其他模型」再打开完整原生选择器：
 * 全部已认证模型、能力详情、⭐（常用）与 📌（启动默认）行内动作。
 *
 * 两者都对齐 CLI：常用（scoped）模型在前，`/scoped-models` 批量编辑。
 * 内容存进 `~/.pi/agent/settings.json` 的共享 `enabledModels`，侧边栏
 * 与终端对「什么是常用」意见一致。
 */

export interface ModelPickerUi {
  /** 启动供应商登录流程（无任何认证时提供）。 */
  login(): Promise<void>;
  /** 往 transcript 推一条单行提示。 */
  status(text: string): void;
}

type AvailableModel = Awaited<ReturnType<PiRuntime["getAvailableModels"]>>[number];

/** 规范的 `provider/modelId` 引用，即 CLI 持久化的格式。 */
function modelRef(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * composer 快捷菜单的模型：只有常用（scoped）的那些，按供应商名聚拢、
 * 供应商内按模型名排序（码元比较，排序不随宿主 ICU 漂移）。什么都没配
 * 时菜单刻意留空：完整目录属于原生选择器，不属于一个小弹层。
 */
export async function buildModelCatalog(runtime: PiRuntime): Promise<ModelCatalog> {
  const items = runtime.scopedModels.map(({ model }) => ({ provider: model.provider, id: model.id }));
  items.sort((a, b) => (a.provider === b.provider ? codeUnitOrder(a.id, b.id) : codeUnitOrder(a.provider, b.provider)));
  return { items };
}

function codeUnitOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 携带「点了哪个行内动作」的 QuickInputButton 扩展。 */
type ModelActionButton = vscode.QuickInputButton & { action?: "toggle-favorite" };

/**
 * 把某模型钉成启动默认的行内按钮。惰性构建：无头冒烟测试加载本模块
 * 时没有真的 `vscode` 运行时。
 */
let setDefaultButton: vscode.QuickInputButton | undefined;
function getSetDefaultButton(): vscode.QuickInputButton {
  setDefaultButton ??= { iconPath: new vscode.ThemeIcon("pin"), tooltip: t("setDefaultModel") };
  return setDefaultButton;
}

/** 往常用组添加/移除模型的行内按钮。 */
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

/** 构建选择器行：常用组在前，其后按供应商分组。 */
function buildModelItems(runtime: PiRuntime, models: AvailableModel[]): ModelItem[] {
  const current = runtime.session.model as { id?: string; provider?: string } | undefined;
  const settings = runtime.settingsManager;
  const defaultRef =
    settings.getDefaultProvider() && settings.getDefaultModel()
      ? `${settings.getDefaultProvider()}/${settings.getDefaultModel()}`
      : undefined;
  const scopedRefs = runtime.scopedModels.map((scoped) => modelRef(scoped.model));
  const scopedSet = new Set(scopedRefs);
  // 订阅状态按供应商区分；每次渲染各解析一次。
  const subscriptionByProvider = new Map<string, boolean>();
  const isSubscription = (provider: string): boolean => {
    let known = subscriptionByProvider.get(provider);
    if (known === undefined) {
      known = runtime.isSubscriptionProvider(provider);
      subscriptionByProvider.set(provider, known);
    }
    return known;
  };

  // 分组也是加垂直呼吸感的唯一手段：QuickPick 行高固定，
  // separator 是仅有的间距原语。
  const items: ModelItem[] = [];
  const row = (model: AvailableModel): ModelItem => {
    const isCurrent = model.id === current?.id && model.provider === current?.provider;
    const isDefault = modelRef(model) === defaultRef;
    const isFavorite = scopedSet.has(modelRef(model));
    // 过滤时 separator 会消失，所以每行自带供应商名，外加告诉用户
    // 该模型如何计费的标记。
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
      // 模型是默认值时也显示常用星标；藏掉它就没了直接取消
      // 该模型常用的唯一入口。
      buttons: [getFavoriteButton(isFavorite), ...(isDefault ? [] : [getSetDefaultButton()])],
      model,
    };
  };

  if (scopedSet.size > 0) {
    items.push({ label: t("favoriteModels"), kind: vscode.QuickPickItemKind.Separator });
    // 保持配置顺序：它也是 CLI Ctrl+P 的轮换顺序。
    for (const reference of scopedRefs) {
      const model = models.find((candidate) => modelRef(candidate) === reference);
      if (model) items.push(row(model));
    }
  }

  const rest = models.filter((model) => !scopedSet.has(modelRef(model)));
  for (const [provider, list] of groupByProvider(rest)) {
    items.push({ label: provider, kind: vscode.QuickPickItemKind.Separator });
    for (const model of list) items.push(row(model));
  }
  return items;
}

/**
 * 按供应商分组的模型，首次出现顺序——两个 QuickPick 共用的列表形状
 * （每个供应商一行 separator，随后是它的模型）。
 */
function groupByProvider(models: readonly AvailableModel[]): Map<string, AvailableModel[]> {
  const byProvider = new Map<string, AvailableModel[]>();
  for (const model of models) {
    const list = byProvider.get(model.provider) ?? [];
    list.push(model);
    byProvider.set(model.provider, list);
  }
  return byProvider;
}

/**
 * 打开完整模型选择器并应用选择。
 *
 * 活动模型变了返回 true。行内动作不出选择器：星标切换常用组，图钉写
 * 启动默认而不关选择器，对齐 CLI 选择器的 Ctrl+S。
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
      // 重渲染，让星标/默认标记挪到新状态。
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

/** 一次直接改常用模型的结果。 */
type FavoriteUpdate = "added" | "removed" | "cleared";

/**
 * 在共享的常用列表里切换一个模型。
 *
 * 与 `/scoped-models` 一样存显式的 `provider/modelId` 列表。用户此前若
 * 手工配过通配符，第一次点星标时其当前解析出的模型会变成显式条目。
 * 全选或全不选都会清空 `enabledModels`，那是 CLI 的「无过滤」表示。
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
 * `/scoped-models`：挑选常用模型并持久化。
 *
 * 与 CLI 选择器一致，保存的值是显式 `provider/modelId` 列表（此前手写
 * 的任何通配符模式被替换），全选或全不选清空该设置。
 */
export async function manageScopedModels(runtime: PiRuntime, ui: ModelPickerUi): Promise<void> {
  const models = await loadModels(runtime, ui);
  if (!models) return;

  const enabled = new Set(runtime.scopedModels.map((scoped) => modelRef(scoped.model)));
  type ModelItem = vscode.QuickPickItem & { model?: AvailableModel };
  const items: ModelItem[] = [];
  for (const [provider, list] of groupByProvider(models)) {
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
  // 「全选」与「全不选」都表示「不做限定」——同 CLI 选择器的规则。
  const clears = selected.length === 0 || selected.length === models.length;
  await runtime.setEnabledModels(clears ? undefined : selected);
  ui.status(clears ? t("favoriteModelsCleared") : tf("favoriteModelsSaved", selected.length));
}

/** 已认证的模型；一个都没有时先提供登录，随后返回 `undefined`。 */
async function loadModels(runtime: PiRuntime, ui: ModelPickerUi): Promise<AvailableModel[] | undefined> {
  const models = (await runtime.getAvailableModels()) as AvailableModel[];
  if (models.length > 0) return models;
  const signIn = t("signInAction");
  const answer = await vscode.window.showWarningMessage(t("noAuthenticatedModel"), signIn);
  if (answer === signIn) await ui.login();
  return undefined;
}

/**
 * 一个模型的 QuickPick 详情行：输入模态（文本/图片）、上下文窗口、最大
 * 输出 token，支持推理时再加推理标记。
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

/** 200000 -> "200K"，1000000 -> "1M"；未知值渲染为 "?"。 */
function formatTokens(value?: number): string {
  if (!value || !Number.isFinite(value) || value <= 0) return "?";
  if (value >= 1_000_000) return `${trimZero(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimZero(value / 1_000)}K`;
  return String(value);
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
