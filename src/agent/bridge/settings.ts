import * as vscode from "vscode";
import {
  affectsFoldConfig,
  affectsLayoutConfig,
  affectsShowThinkingConfig,
  affectsSubagentConfig,
  affectsTerminalConfig,
  readContentMaxWidth,
  readFoldLines,
  readShowThinking,
  readSubagentConfig,
  readTerminalConfig,
  readWideThreshold,
} from "../config.js";
import { t } from "../i18n.js";
import type { ChatBridge } from "./chat-bridge.js";
import { SETTINGS_DEBOUNCE_MS } from "./types.js";

/**
 * 开始响应插件自有 VS Code 设置的变更。委派工具在会话构造时固化进
 * 工具集，reload() 又保留宿主的 customTools，已开讲的会话吃不到新值。
 * 设置界面逐键触发，而下面的响应不能逐键跑——一个重建会话、一个重放
 * 整个 transcript——故每项设置各自防抖；布局几何只写 CSS 变量，不需
 * 重建也不需重放，也就不设防抖。
 */
export function createSettingsWatcher(bridge: ChatBridge): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (affectsSubagentConfig(event, bridge.runtime.cwd)) {
      if (bridge.subagentConfigTimer) clearTimeout(bridge.subagentConfigTimer);
      bridge.subagentConfigTimer = setTimeout(() => {
        bridge.subagentConfigTimer = undefined;
        void applySubagentConfigChange(bridge);
      }, SETTINGS_DEBOUNCE_MS);
    }
    if (affectsTerminalConfig(event, bridge.runtime.cwd)) {
      if (bridge.terminalConfigTimer) clearTimeout(bridge.terminalConfigTimer);
      bridge.terminalConfigTimer = setTimeout(() => {
        bridge.terminalConfigTimer = undefined;
        void applyTerminalConfigChange(bridge);
      }, SETTINGS_DEBOUNCE_MS);
    }
    if (affectsFoldConfig(event)) {
      if (bridge.foldConfigTimer) clearTimeout(bridge.foldConfigTimer);
      bridge.foldConfigTimer = setTimeout(() => {
        bridge.foldConfigTimer = undefined;
        applyFoldConfigChange(bridge);
      }, SETTINGS_DEBOUNCE_MS);
    }
    if (affectsShowThinkingConfig(event)) {
      if (bridge.showThinkingConfigTimer) clearTimeout(bridge.showThinkingConfigTimer);
      bridge.showThinkingConfigTimer = setTimeout(() => {
        bridge.showThinkingConfigTimer = undefined;
        applyShowThinkingChange(bridge);
      }, SETTINGS_DEBOUNCE_MS);
    }
    if (affectsLayoutConfig(event)) postContentWidth(bridge);
  });
}

/** 清掉全部待执行的防抖设置响应（bridge 销毁时）。 */
export function disposeSettingsTimers(bridge: ChatBridge): void {
  if (bridge.subagentConfigTimer) {
    clearTimeout(bridge.subagentConfigTimer);
    bridge.subagentConfigTimer = undefined;
  }
  if (bridge.terminalConfigTimer) {
    clearTimeout(bridge.terminalConfigTimer);
    bridge.terminalConfigTimer = undefined;
  }
  if (bridge.foldConfigTimer) {
    clearTimeout(bridge.foldConfigTimer);
    bridge.foldConfigTimer = undefined;
  }
  if (bridge.showThinkingConfigTimer) {
    clearTimeout(bridge.showThinkingConfigTimer);
    bridge.showThinkingConfigTimer = undefined;
  }
}

/**
 * 响应子代理设置的变更。工具集在构造时固定，新值只能等 runtime 构造
 * 下一个会话时生效——那是任意会话替换（新建 / 切换 / fork / 导入）与
 * 下次窗口启动，不只是全新对话。空会话是宿主能直接重建的唯一情形：
 * 没有对话可丢；「新建」按钮在空会话上本就禁用（否则只剩重载窗口），
 * 而未写盘的会话在磁盘上从未存在，命名过的空会话仍留在列表里。比较
 * 对象是会话构造时那份配置：重存同值不得付出重建或提示。
 */
async function applySubagentConfigChange(bridge: ChatBridge): Promise<void> {
  if (bridge.disposed) return;
  const before = bridge.runtime.builtSubagentConfig;
  const now = readSubagentConfig(bridge.runtime.cwd);
  if (now.enabled === before.enabled && now.maxSubagents === before.maxSubagents && now.defaultModel === before.defaultModel) {
    return;
  }
  await applyToolConfigChange(bridge, "subagentSettingChanged", "subagentSettingApplied", "subagent settings rebuild failed");
}

/**
 * 终端工具设置的同一响应。保留独立的比较而不与子代理合并：两者是
 * 不同的工具、文案各异。先触发者替两者重建会话，后来者发现自己那组
 * 值已构造、直接返回，不会有第二次重建。
 */
async function applyTerminalConfigChange(bridge: ChatBridge): Promise<void> {
  if (bridge.disposed) return;
  const before = bridge.runtime.builtTerminalConfig;
  const now = readTerminalConfig(bridge.runtime.cwd);
  if (now.enabled === before.enabled && now.maxTerminals === before.maxTerminals) return;
  await applyToolConfigChange(bridge, "terminalSettingChanged", "terminalSettingApplied", "terminal settings rebuild failed");
}

/** 为变更的工具设置重建空会话；不行就说明原因。 */
async function applyToolConfigChange(
  bridge: ChatBridge,
  changedMessage: "subagentSettingChanged" | "terminalSettingChanged",
  appliedMessage: "subagentSettingApplied" | "terminalSettingApplied",
  errorLabel: string,
): Promise<void> {
  if (!canRebuildForToolConfig(bridge)) {
    bridge.emitCommandStatus(t(changedMessage));
    return;
  }
  try {
    await bridge.runtime.newSession();
    await bridge.attach();
  } catch (error) {
    bridge.reportError(bridge.runtime.session, errorLabel, error, "command");
    return;
  }
  // 放在 attach() 之后：落在新建会话的 transcript 里，而不是刚被替换的那个。
  bridge.emitCommandStatus(t(appliedMessage));
}

function canRebuildForToolConfig(bridge: ChatBridge): boolean {
  if (bridge.view.kind !== "live") return false;
  const session = bridge.runtime.session;
  if (session.messages.length > 0) return false;
  if (session.isStreaming || session.isCompacting) return false;
  // 委派 run 比父会话的轮次活得久；在它下面重建会让 lane 替一个已消失的会话写文件。
  return !bridge.runtime.subagents.isRunning;
}

/**
 * 三个推送给 webview 的值共享同一条归属规则：webview 读不到 VS Code
 * 设置，值由宿主持有，且必须先于任何历史到达——气泡 / 思考卡在构建时
 * 就决定折不折叠。contentWidth 每次 ready 无条件重推：控制器交换会
 * 重赋 webview.html、webview 整个重载，新实例只认识文档默认值——
 * 「已推过」是 webview 的属性而非本 bridge 的。
 */
export function postFoldThreshold(bridge: ChatBridge): void {
  const lines = readFoldLines();
  bridge.foldLines = lines;
  bridge.host.post({ type: "foldThreshold", maxLines: lines });
}

export function postShowThinking(bridge: ChatBridge): void {
  const enabled = readShowThinking();
  bridge.showThinking = enabled;
  bridge.host.post({ type: "showThinking", enabled });
}

export function postContentWidth(bridge: ChatBridge): void {
  bridge.host.post({ type: "contentWidth", maxWidth: readContentMaxWidth(), wideMinWidth: readWideThreshold() });
}

/**
 * 折叠阈值变更经一次全量重放触达已有气泡：折叠决定在气泡构建时烙定，
 * 重放同时恢复用户的阅读位置与手动展开，重新判定不丢任何东西。纯呈现
 * 变化：不重建会话、不发 transcript 提示；重存同值不重放。
 */
function applyFoldConfigChange(bridge: ChatBridge): void {
  if (bridge.disposed) return;
  const lines = readFoldLines();
  if (lines === bridge.foldLines) return;
  postFoldThreshold(bridge);
  bridge.postHistory();
}

/** showThinking 变更走与折叠阈值相同的重放路径（展开决定同样烙定在构建时）；重存同值不重放。 */
function applyShowThinkingChange(bridge: ChatBridge): void {
  if (bridge.disposed) return;
  const enabled = readShowThinking();
  if (enabled === bridge.showThinking) return;
  postShowThinking(bridge);
  bridge.postHistory();
}
