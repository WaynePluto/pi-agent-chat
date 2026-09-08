import * as vscode from "vscode";
import { formatLocalTimestamp } from "../../shared/time.js";
import { t } from "../i18n.js";
import { manageScopedModels, pickModel as openModelPicker } from "../model-picker.js";
import { buildSkillIndex } from "../skills.js";
import { buildPromptIndex } from "../invocations.js";
import type { ChatBridge } from "./chat-bridge.js";
import { listSessions } from "./sessions-list.js";

/**
 * 交给内置命令、斜杠命令处理器与设置菜单的动作面：一块 UI 能请求本
 * bridge 做的每件事。
 */
export function builtinActions(bridge: ChatBridge) {
  return {
    newSession: async () => {
      if (bridge.guardStreaming()) return;
      await bridge.runtime.newSession();
      await bridge.attach();
    },
    resumeSession: async () => {
      if (bridge.guardStreaming()) return;
      const items = await listSessions(bridge);
      const picked = await vscode.window.showQuickPick(
        items.map((item) => ({
          label: item.title,
          description: formatLocalTimestamp(item.timestamp),
          file: item.file,
        })),
        { title: t("resumeSessionTitle") },
      );
      if (!picked) return;
      if (await bridge.runtime.switchSession(picked.file)) await bridge.attach();
    },
    pickModel: async (argument: string) => {
      if (argument.includes("/")) {
        const [providerId, ...rest] = argument.split("/");
        await bridge.runtime.setModel(providerId!, rest.join("/"));
        return;
      }
      // 选择器现在住在 composer 里；`/model` 只负责在那里打开它。
      bridge.host.post({ type: "openPicker", picker: "model" });
    },
    manageScopedModels: async () => {
      await manageScopedModels(bridge.runtime, modelPickerUi(bridge));
      await bridge.postModels();
      await bridge.postState();
    },
    login: async () => {
      await bridge.login();
    },
    logout: async () => {
      await bridge.logout();
    },
    reload: async () => {
      await reloadResources(bridge);
    },
    reattach: async () => bridge.attach(),
    status: (text: string) => bridge.emit(bridge.runtime.session, { kind: "status", text, scope: "command" }),
    setInput: (text: string) => bridge.host.post({ type: "setInput", text }),
    refresh: () => void bridge.postState(),
  };
}

/** 模型选择器需要的更窄接口（提示 + 登录）。 */
export function modelPickerUi(bridge: ChatBridge) {
  return {
    login: async () => {
      await bridge.login();
    },
    status: (text: string) => bridge.emitCommandStatus(text),
  };
}

/**
 * `/reload` 及其周边的簿记；与扩展命令的 `ctx.reload()` 共用——两者必须
 * 行为一致。
 */
export async function reloadResources(bridge: ChatBridge): Promise<void> {
  // reload() 原地替换扩展实例；session 对象不变，订阅与 histories 幸存。
  const session = bridge.runtime.session;
  await bridge.runtime.reloadResources({
    beforeSessionStart: () => bridge.clearExtensionUiState(session),
  });
  // 重载后的扩展集刚刚收到 session_start。
  bridge.activity.noteBind(session);
  bridge.skillIndex = buildSkillIndex(session);
  bridge.promptIndex = buildPromptIndex(session);
  bridge.postCommands();
  bridge.postResources();
}

/**
 * composer 菜单「其他模型」打开的完整原生选择器。它还可能改常用列表与
 * 默认模型，故事后重建快捷菜单内容。
 */
export async function pickModel(bridge: ChatBridge): Promise<void> {
  const changed = await openModelPicker(bridge.runtime, modelPickerUi(bridge));
  await bridge.postModels();
  if (changed) await bridge.postState();
}

export async function setModel(bridge: ChatBridge, provider: string, modelId: string): Promise<void> {
  try {
    await bridge.runtime.setModel(provider, modelId);
  } catch (error) {
    bridge.reportError(bridge.runtime.session, "model switch failed", error, "command");
    return;
  }
  await bridge.postState();
}

/** 应用 webview 选定的思考等级；模型不支持的等级忽略。 */
export function setThinkingLevel(bridge: ChatBridge, requested: string): void {
  const session = bridge.runtime.session;
  const level = session.getAvailableThinkingLevels().find((candidate) => candidate === requested);
  if (!level) {
    bridge.host.log(`ignored unsupported thinking level: ${requested}`);
    return;
  }
  session.setThinkingLevel(level);
}
