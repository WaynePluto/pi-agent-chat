import * as vscode from "vscode";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import { describe } from "../errors.js";
import { t, tf } from "../i18n.js";
import { isModelsConfigPath, repairEmptyModelsConfig } from "../model-config.js";
import { loginFlow, logoutFlow } from "../auth.js";
import type { ChatBridge } from "./chat-bridge.js";
import { MODEL_REFRESH_TIMEOUT_MS } from "./types.js";

/**
 * 开始监视共享的 `~/.pi/agent/models.json` 的保存。自定义供应商在
 * models.json 里手工配置（见 model-config.ts），保存该文件就是它唯一的
 * 「应用」手势，故保存即重载——与 CLI 在 `/model` 打开时重载一致。
 */
export function createModelsConfigWatcher(bridge: ChatBridge): vscode.Disposable {
  return vscode.workspace.onDidSaveTextDocument((document) => {
    if (isModelsConfigPath(document.uri.fsPath)) void reloadModelsConfig(bridge);
  });
}

/**
 * 重读 `~/.pi/agent/models.json` 并把结果报告进 transcript。不走网络：
 * 变的只是本地文件，远程目录已在登录 / 登出时刷新（同 CLI）。
 */
export async function reloadModelsConfig(bridge: ChatBridge): Promise<void> {
  const session = bridge.runtime.session;
  const before = { loaded: loadedModelIds(bridge), available: new Set(availableModelRefs(bridge)) };
  try {
    await bridge.runtime.modelRuntime.refresh({ allowNetwork: false, signal: bridge.runtime.signal });
    const failed = await reportModelsConfigError(bridge, session);
    await rescopeModels(bridge);
    await bridge.postModels();
    await bridge.postState();
    if (failed) return;
    const available = await bridge.runtime.getAvailableModels();
    const lines = [tf("modelsConfigReloaded", available.length)];
    lines.push(...describeModelChanges(bridge, before, available));
    bridge.emit(session, { kind: "status", text: lines.join("\n"), scope: "command" });
  } catch (error) {
    if (bridge.disposed) return;
    bridge.reportError(session, "models.json reload failed", error, "command");
  }
}

/** 全部已加载模型（不论认证），按 `provider` -> model id。 */
function loadedModelIds(bridge: ChatBridge): Map<string, Set<string>> {
  const byProvider = new Map<string, Set<string>>();
  for (const model of bridge.runtime.modelRuntime.getModels()) {
    const ids = byProvider.get(model.provider) ?? new Set<string>();
    ids.add(model.id);
    byProvider.set(model.provider, ids);
  }
  return byProvider;
}

/** 选择器当前会提供的 `provider/modelId` 全集。 */
function availableModelRefs(bridge: ChatBridge): string[] {
  return bridge.runtime.modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`);
}

/**
 * 解释这次编辑实际产出了什么。pi 不论认证都加载供应商的模型，却只提供
 * 已认证的那些：挂在解析不了的凭据后面的模型（占位符、VS Code 进程
 * 看不见的 `$VAR`）就此消失，而 `getError()` 为空——文件本身完全合法，
 * 没有别人会报这一点。
 */
function describeModelChanges(
  bridge: ChatBridge,
  before: { loaded: Map<string, Set<string>>; available: Set<string> },
  available: readonly { provider: string; id: string }[],
): string[] {
  const lines: string[] = [];
  const added = available
    .map((model) => `${model.provider}/${model.id}`)
    .filter((reference) => !before.available.has(reference));
  if (added.length > 0) lines.push(tf("modelsConfigAdded", added.join(", ")));
  const availableIds = new Set(available.map((model) => `${model.provider}/${model.id}`));
  for (const [provider, ids] of loadedModelIds(bridge)) {
    if (bridge.runtime.modelRuntime.getProviderAuthStatus(provider).configured) continue;
    const hidden = [...ids].filter(
      (id) => !before.loaded.get(provider)?.has(id) && !availableIds.has(`${provider}/${id}`),
    );
    if (hidden.length > 0) lines.push(tf("modelsConfigUnauthenticated", provider, hidden.length));
  }
  return lines;
}

/**
 * 按 CLI 各 mode 的方式呈现损坏的 models.json；缺了它，一个笔误会静默
 * 丢掉该文件定义的自定义供应商。返回当前是否配置了错误。完全空配置是
 * 唯一有无损修复的「错误」：pi 拒绝空文件与 `{}`，而空 `providers` 映射
 * 是它接受的等价说法；保存修复会重跑本次重载、报告真实状态。
 */
export async function reportModelsConfigError(bridge: ChatBridge, session: AgentSession): Promise<boolean> {
  const error = bridge.runtime.modelRuntime.getError();
  if (error && (await repairEmptyModelsConfig())) {
    bridge.emit(session, { kind: "status", text: t("modelsConfigRepaired"), scope: "command" });
    bridge.modelsConfigError = undefined;
    return true;
  }
  if (error && error !== bridge.modelsConfigError) {
    bridge.emit(session, { kind: "error", text: tf("modelsConfigError", error), scope: "command" });
  }
  bridge.modelsConfigError = error;
  return Boolean(error);
}

/**
 * 可用性变化后重新解析会话的常用模型。`session.scopedModels`——composer
 * 快捷菜单的数据源——在会话构建与列表本身被编辑时解析，认证变化会让它
 * 过期：登出的供应商赖在菜单里（新认证的进不来）直到下一个会话。失败
 * 只记日志、不致命：落后的只是快捷菜单内容，聊天不受影响。
 */
export async function rescopeModels(bridge: ChatBridge): Promise<void> {
  try {
    await bridge.runtime.rescopeSessionModels();
  } catch (error) {
    bridge.host.log(`scoped models refresh failed: ${describe(error)}`);
  }
}

/**
 * 按需从网络重新拉取全部供应商的模型目录（设置菜单的「刷新」项）。
 * 目录拉取失败不致命——供应商保留缓存列表——但此前没有任何重试路径，
 * 登录 / 登出是仅有的自动触发。与 CLI 模型选择器每次打开时的调用相同。
 */
export async function refreshModelCatalog(bridge: ChatBridge): Promise<void> {
  const session = bridge.runtime.session;
  const timeout = AbortSignal.timeout(MODEL_REFRESH_TIMEOUT_MS);
  let result: ModelsRefreshResult;
  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t("modelsRefreshing") },
      () => bridge.runtime.refreshModelCatalog(timeout),
    );
  } catch (error) {
    bridge.reportError(session, "model catalog refresh failed", error, "command");
    return;
  }
  if (bridge.disposed) return;
  if (result.aborted && timeout.aborted) {
    bridge.emit(session, { kind: "error", text: t("modelsRefreshTimedOut"), scope: "command" });
  } else if (result.errors.size > 0) {
    // 与登录 / 登出的告警同形：供应商名 + 首个底层原因（`cause` 已由 describe() 解包）。
    const names = [...result.errors.keys()].map((id) => bridge.runtime.modelRuntime.getProvider(id)?.name ?? id);
    bridge.emit(session, {
      kind: "error",
      text: tf("modelRefreshFailed", names.join(", "), describe([...result.errors.values()][0])),
      scope: "command",
    });
  } else {
    // 用快照而非 getAvailable()：目录才是本动作取来的东西，新的认证探测只会多出自己的失败模式。
    bridge.emit(session, {
      kind: "status",
      text: tf("modelsRefreshed", bridge.runtime.modelRuntime.getAvailableSnapshot().length),
      scope: "command",
    });
  }
  await rescopeModels(bridge);
  await bridge.postModels();
  await bridge.postState();
}

export async function login(bridge: ChatBridge): Promise<boolean> {
  const changed = await loginFlow(bridge.runtime, (message) => bridge.host.log(message));
  if (changed) {
    await rescopeModels(bridge);
    await bridge.postModels();
    await bridge.postState();
  }
  return changed;
}

export async function logout(bridge: ChatBridge): Promise<boolean> {
  const changed = await logoutFlow(bridge.runtime, (message) => bridge.host.log(message));
  if (changed) {
    await rescopeModels(bridge);
    await bridge.postModels();
    await bridge.postState();
  }
  return changed;
}
