import { existsSync } from "node:fs";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ChatState, ChatStats, SubagentSetup, ToolSetup } from "../../shared/protocol.js";
import { describe } from "../errors.js";
import { buildModelCatalog } from "../model-picker.js";
import { collectSlashCommands } from "../commands.js";
import { bubbleEntryIds } from "../history.js";
import { firstUserLine } from "../session-title.js";
import { collectResourceSections } from "../resources.js";
import type { ChatBridge } from "./chat-bridge.js";
import { postExtensionStatus, postExtensionWidgets } from "./extension-ui.js";
import { delegationState } from "./lanes.js";
import { withRetryOffer } from "./retry.js";

import { buildSkillIndex } from "../skills.js";
import { buildPromptIndex } from "../invocations.js";

/**
 * live 会话变化时告知宿主。全新会话已有路径，但背后的文件要到首次追加
 * 才写——在那之前下次窗口没有可重开的东西，`undefined` 说的正是「用户
 * 停在新建的空会话里」。逐事件调用也便宜：文件确认存在后首次比较即
 * 短路，在那之前会话必然空闲。
 */
export function rememberSession(bridge: ChatBridge): void {
  const file = bridge.runtime.session.sessionFile;
  if (bridge.remembered && bridge.remembered.file === file) return;
  const resumable = file !== undefined && existsSync(file) ? file : undefined;
  if (bridge.remembered && bridge.remembered.file === resumable) return;
  bridge.remembered = { file: resumable };
  bridge.host.rememberSession?.(resumable);
}

/**
 * CLI 风格的启动清单（[Context] / [Skills] / [Prompts] / [Extensions] /
 * [Tools]），在 header 的资源开关打开时显示于 transcript 上方。扩展与
 * 技能此时已（重）加载，顺带刷新匹配器。
 */
export function postResources(bridge: ChatBridge): void {
  try {
    bridge.skillIndex = buildSkillIndex(bridge.runtime.session);
    bridge.promptIndex = buildPromptIndex(bridge.runtime.session);
  } catch (error) {
    bridge.host.log(`failed to refresh resource matchers: ${describe(error)}`);
  }
  postResourceListing(bridge);
}

/** 只重发清单本身：变的仅是「生效过」标记，其背后的匹配器仍然有效。 */
export function postResourceListing(bridge: ChatBridge): void {
  try {
    bridge.host.post({ type: "resources", sections: collectResourceSections(bridge.runtime, bridge.activity) });
  } catch (error) {
    bridge.host.log(`failed to collect resources: ${describe(error)}`);
  }
}

export function postCommands(bridge: ChatBridge): void {
  try {
    bridge.host.post({ type: "commands", items: collectSlashCommands(bridge.runtime.session) });
  } catch (error) {
    bridge.host.log(`failed to collect slash commands: ${describe(error)}`);
  }
}

/** composer 模型选择器的已认证模型；webview 按需请求，凭据或常用 / 默认标记变化时重推。 */
export async function postModels(bridge: ChatBridge): Promise<void> {
  try {
    bridge.host.post({ type: "models", catalog: await buildModelCatalog(bridge.runtime) });
  } catch (error) {
    bridge.host.log(`failed to collect models: ${describe(error)}`);
  }
}

/**
 * 重放持久化 transcript，resume 的会话不显示为空。populateInputHistory
 * 标记「会话刚成为 live」，webview 据此把回放的用户消息灌进 composer 的
 * ↑ 历史（对齐 CLI 初次渲染）；只有 attach() 与 ready 传 true，其余重放
 * 是往返、不得重复灌入，且该标志在 replay 文件上无意义（防御未来调用
 * 者误灌 preview）。live: 仍在流式的会话其重放不得关掉打开的 work
 * block——live 事件会继续追加到同一张卡片。
 */
export function postHistory(bridge: ChatBridge, populateInputHistory = false): void {
  const session = bridge.displayedSession;
  /* SYSTEM.md 替换 SDK 默认提示词（含告知模型 Pi 自带文档与示例位置的
     绝对路径）。subagent / terminal 是新会话提示的条件段落而非 transcript
     事件：它说的是会话怎么装配，不是里面发生了什么；当事件发还会顶掉
     它所属的占位符。 */
  const systemPromptOverridden = Boolean(session.resourceLoader.getSystemPromptSource());
  const subagent: SubagentSetup = {
    enabled: bridge.runtime.subagentEnabled,
    shadowedExtension: bridge.runtime.shadowedSubagentExtension,
  };
  const terminal: ToolSetup = {
    enabled: bridge.runtime.terminalEnabled,
    shadowedExtension: bridge.runtime.shadowedTerminalExtension,
  };
  const populate = populateInputHistory && bridge.view.kind !== "replay";
  if (bridge.view.kind === "replay") {
    bridge.host.post({
      type: "history",
      events: [...bridge.view.events],
      transcriptId: bridge.view.file,
      systemPromptOverridden,
      subagent,
      terminal,
    });
    postEntryIds(bridge);
    return;
  }
  const events = bridge.histories.get(session.sessionId) ?? bridge.buildHistory(session);
  bridge.histories.set(session.sessionId, events);
  bridge.host.post({
    type: "history",
    events: withRetryOffer(bridge, session, events),
    live: session.isStreaming,
    transcriptId: session.sessionId,
    systemPromptOverridden,
    subagent,
    terminal,
    populateInputHistory: populate,
  });
  postEntryIds(bridge);
  postExtensionStatus(bridge);
  postExtensionWidgets(bridge);
}

/**
 * 告知 webview 每个消息气泡对应哪个会话条目，让逐气泡动作（回溯 /
 * 分叉 / 标签）可寻址。两种角色都可寻址：assistant 回答也是条目，可
 * 回到、可在其上分叉、加书签。只有 live 父会话 transcript 可操作——
 * 运行中的委派也挡住它（在运行下面改写历史会搁浅它的 lane）；lane 与
 * replay 得到空表、按钮隐藏。
 */
export function postEntryIds(bridge: ChatBridge): void {
  const session = bridge.runtime.session;
  const actionable = bridge.view.kind === "live" && !bridge.activeRun;
  if (!actionable) {
    bridge.host.post({ type: "entryIds", ids: [], labels: [], assistantIds: [], assistantLabels: [] });
    return;
  }
  try {
    const label = (id: string) => session.sessionManager.getLabel(id);
    const { user, assistant } = bubbleEntryIds(session.sessionManager.getBranch());
    bridge.host.post({
      type: "entryIds",
      ids: user,
      labels: user.map(label),
      assistantIds: assistant,
      assistantLabels: assistant.map(label),
    });
  } catch (error) {
    bridge.host.log(`failed to collect entry ids: ${describe(error)}`);
  }
}

export async function postState(bridge: ChatBridge): Promise<void> {
  /* getAvailableModels() 是异步的：没有版本号检查，在子会话显示期间开始
     的状态快照可能晚于子会话结束到达，覆盖权威的父会话状态。探测也被
     直接取消，让被取代的调用不再碰供应商。 */
  const postVersion = ++bridge.statePostVersion;
  bridge.availabilityProbe?.abort();
  const probe = new AbortController();
  bridge.availabilityProbe = probe;
  const session = bridge.displayedSession;
  const model = session.model as { id?: string; provider?: string } | undefined;
  let needsAuth = false;
  try {
    needsAuth = (await bridge.runtime.getAvailableModels(probe.signal)).length === 0;
  } catch {
    // 可用性检查失败（或被取消）不得挡住聊天 UI。
  }
  if (postVersion !== bridge.statePostVersion || bridge.disposed) return;
  const replay = bridge.view.kind === "replay" ? bridge.view : undefined;
  const state: ChatState = {
    ready: true,
    cwd: bridge.runtime.cwd,
    sessionFile: session.sessionFile,
    sessionId: session.sessionId,
    sessionName: sessionDisplayName(session),
    modelId: model?.id,
    providerId: model?.provider,
    thinkingLevel: session.thinkingLevel,
    thinkingLevels: session.getAvailableThinkingLevels(),
    // replay 期间 live 运行继续，但屏上 transcript 是静态历史：无停止按钮、无运行指示。
    isStreaming: replay ? false : session.isStreaming,
    isCompacting: replay ? false : session.isCompacting,
    needsAuth,
    messageCount: session.messages.length,
    // 委派在 replay 中幸存：live session 已消失的子代理以其文件回放展示，此处丢掉委派会剥掉让它读作子代理的框架——replay 的含义只在 delegationState 决定一次。
    delegation: delegationState(bridge, session),
    preview: replay ? { file: replay.file, title: replay.title } : undefined,
    inputDisabled: bridge.view.kind !== "live",
    stats: collectStats(session),
  };
  bridge.host.post({ type: "state", state });
}

export function sessionDisplayName(session: AgentSession): string | undefined {
  return session.sessionManager.getSessionName()
    ?? firstUserLine(session.messages as Array<{ role?: string; content?: unknown }>);
}

export function collectStats(session: AgentSession): ChatStats | undefined {
  try {
    const stats = session.getSessionStats();
    const usage = session.getContextUsage();
    const cacheable = stats.tokens.cacheRead + stats.tokens.input;
    return {
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      cacheHitPercent: cacheable > 0 ? (stats.tokens.cacheRead / cacheable) * 100 : undefined,
      cost: stats.cost,
      contextPercent: usage?.percent ?? undefined,
      contextWindow: usage?.contextWindow,
    };
  } catch {
    return undefined;
  }
}
