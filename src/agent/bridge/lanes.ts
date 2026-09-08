import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatState, DelegationLane } from "../../shared/protocol.js";
import { t, tf } from "../i18n.js";
import { buildHistoryEntryEvents } from "../history.js";
import type { LaneNotice, LaneState, SubagentRun } from "../subagent.js";
import type { ChatBridge } from "./chat-bridge.js";
import { REPLAYED_LANE_ID } from "./types.js";
import type { View } from "./types.js";
import { refreshSessions } from "./sessions-list.js";

/**
 * 切换 webview 显示的内容，并推送一切由它派生的状态。视图变更只发生在
 * 这里：任何调用方都不可能只改一半 UI 而漏掉其余。
 */
export function setView(bridge: ChatBridge, view: View): void {
  bridge.view = view;
  if (view.kind === "live") bridge.parentActivityWhileAway = false;
  bridge.postHistory();
  bridge.postCommands();
  bridge.postResources();
  void bridge.postState();
}

export function onRunStarted(bridge: ChatBridge, run: SubagentRun): void {
  bridge.activeRun = run;
  mergeLanes(bridge, run.lanes);
  /* 绝不替用户移动视图：run 开始时不跳进 lane，结束时也不弹回。在 agent
     transcript 之间切换是用户自己的动作——run 在用户不在父会话时启动，只
     把它记为「有新进展」。「不在」也包括回放中的子代理：lane 的 session
     消失后它就是回放。 */
  if (bridge.view.kind !== "live") bridge.parentActivityWhileAway = true;
  void bridge.postState();
  refreshSessions(bridge);
}

/** 增加或刷新 lane 快照；早前运行的 lane 保持可达。 */
function mergeLanes(bridge: ChatBridge, lanes: readonly LaneState[]): void {
  for (const lane of lanes) {
    const index = bridge.lanes.findIndex((known) => known.id === lane.id);
    if (index >= 0) bridge.lanes[index] = lane;
    else bridge.lanes.push(lane);
  }
}

export function onLaneStarted(bridge: ChatBridge, run: SubagentRun, lane: LaneState, session: AgentSession): void {
  if (bridge.activeRun !== run) return;
  bridge.laneSessions.set(lane.id, session);
  // 用任务文本为 lane transcript 起头，正如父会话的 transcript 始于一条用户消息。
  bridge.histories.set(session.sessionId, [{ kind: "user_message", text: lane.task }]);
  mergeLanes(bridge, run.lanes);
  void bridge.postState();
  refreshSessions(bridge);
}

export function onLaneChanged(bridge: ChatBridge, run: SubagentRun, _lane: LaneState): void {
  if (bridge.activeRun !== run) return;
  mergeLanes(bridge, run.lanes);
  void bridge.postState();
}

export function onLaneEvent(bridge: ChatBridge, run: SubagentRun, lane: LaneState, event: AgentSessionEvent): void {
  if (bridge.activeRun !== run) return;
  const session = bridge.laneSessions.get(lane.id);
  if (session) bridge.onSessionEvent(session, event);
}

/**
 * 子代理用不了用户为它配置的模型。落在用户所在的父会话 transcript 里，
 * 且不出现在父代理收到的汇报中：那个模型不是它选的，它既改不了拼写
 * 也补不了凭据，报给它只会引诱它去「修正」自己没发过的参数。
 */
export function onLaneNotice(bridge: ChatBridge, run: SubagentRun, lane: LaneState, notice: LaneNotice): void {
  if (bridge.activeRun !== run) return;
  const source = t("subagentModelSourceSetting");
  const using = notice.using ?? t("subagentModelFallbackParent");
  bridge.emit(run.parent, {
    kind: "status",
    text: tf("subagentModelFallback", lane.title, notice.requested, source, using),
  });
}

export function onRunFinished(bridge: ChatBridge, run: SubagentRun): void {
  if (bridge.activeRun !== run) return;
  for (const lane of run.lanes) {
    const session = bridge.laneSessions.get(lane.id);
    if (!session) continue;
    bridge.emit(session, {
      kind: lane.status === "completed" ? "status" : "error",
      text: lane.summary ?? lane.status,
    });
  }
  bridge.activeRun = undefined;
  mergeLanes(bridge, run.lanes);
  // 刻意不切回：正在读 lane 的用户继续读，返回入口长出「主代理有新进展」标记。
  if (bridge.view.kind !== "live") bridge.parentActivityWhileAway = true;
  void bridge.postState();
  refreshSessions(bridge);
}

/**
 * 显示会话所见的委派状态。它在 run 结束后仍然存在：用户打开过的 lane
 * 保持可读，父会话卡片保留最终计数而不是消失。以会话文件回放展示的
 * 子代理（窗口重载后它的全部残余）在用户看来仍是子代理，故保留 lane
 * 呈现框架。
 */
export function delegationState(bridge: ChatBridge, session: AgentSession): ChatState["delegation"] {
  if (bridge.view.kind === "replay") {
    const file = bridge.view.file;
    const known = bridge.lanes.find((lane) => lane.sessionFile === file);
    const lane: DelegationLane = known
      ? toDelegationLane(known)
      : { id: REPLAYED_LANE_ID, title: bridge.view.laneTitle, scope: [], status: "completed", writtenFiles: [] };
    return {
      role: "child",
      lanes: [lane],
      currentLaneId: lane.id,
      running: Boolean(bridge.activeRun),
      parentHasNewActivity: bridge.parentActivityWhileAway,
    };
  }
  if (bridge.lanes.length === 0) return undefined;
  const lanes = bridge.lanes.map((lane) => toDelegationLane(lane));
  const running = Boolean(bridge.activeRun);
  if (bridge.view.kind === "lane") {
    // 不再匹配任何已知 lane 的 lane id 会画出无 lane 可命名的横幅；转而落回父会话视图。
    const laneId = bridge.view.laneId;
    if (bridge.lanes.some((lane) => lane.id === laneId)) {
      return { role: "child", lanes, currentLaneId: laneId, running, parentHasNewActivity: bridge.parentActivityWhileAway };
    }
  }
  if (session === bridge.runtime.session) return { role: "parent", lanes, running };
  return undefined;
}

function toDelegationLane(lane: LaneState): DelegationLane {
  return {
    id: lane.id,
    title: lane.title,
    scope: [...lane.scope],
    status: lane.status,
    progress: lane.progress,
    writtenFiles: [...lane.writtenFiles],
    bashMayHaveWritten: lane.bashMayHaveWritten || undefined,
    scopeViolations: lane.scopeViolations || undefined,
    sessionId: lane.sessionId,
    sessionFile: lane.sessionFile,
    durationMs: lane.endedAt ? lane.endedAt - lane.startedAt : undefined,
  };
}

/**
 * 把显示的 transcript 切到某一路 lane，或切回父会话。lane 完成后仍可以
 * lane 身份查看（child session 保留到下一次 run），运行中与已完成的
 * 子代理都走这条路。lane 也可以只用文件寻址：别的 bridge 渲染的会话
 * 列表知道该行是子代理（窗口说的），却不知道本次 run 给它的 lane id。
 * child session 已消失时（早前窗口或会话切换），回放磁盘上的文件并
 * 保持子代理框架。
 */
export function showLane(bridge: ChatBridge, laneId?: string, fallbackFile?: string, laneTitle?: string): void {
  const resolved = laneId ?? (fallbackFile ? bridge.lanes.find((lane) => lane.sessionFile === fallbackFile)?.id : undefined);
  if (!resolved) {
    if (fallbackFile) void replayLaneSession(bridge, fallbackFile, laneTitle ?? "");
    else setView(bridge, { kind: "live" });
    return;
  }
  const session = bridge.laneSessions.get(resolved);
  if (!session) {
    if (fallbackFile) void replayLaneSession(bridge, fallbackFile, laneTitle ?? "");
    return;
  }
  setView(bridge, { kind: "lane", laneId: resolved, session });
}

/**
 * 回放 live child session 已不复存在的历史子代理。普通顶层会话绝不走
 * 这条路：选中它们会构造可写的顶层 controller——即使当前 controller
 * 正在运行。
 */
export async function replayLaneSession(bridge: ChatBridge, file: string, laneTitle: string): Promise<void> {
  if (file === bridge.runtime.session.sessionFile) {
    setView(bridge, { kind: "live" });
    return;
  }
  try {
    const manager = SessionManager.open(file);
    const events = buildHistoryEntryEvents(manager.getBranch(), bridge.runtime.cwd, bridge.skillIndex, bridge.promptIndex);
    const firstUser = events.find((event) => event.kind === "user_message") as { text?: string } | undefined;
    setView(bridge, { kind: "replay", file, title: (firstUser?.text ?? "").split("\n")[0] ?? "", events, laneTitle });
    refreshSessions(bridge);
  } catch (error) {
    bridge.reportError(bridge.runtime.session, "subagent replay failed", error, "command");
  }
}
