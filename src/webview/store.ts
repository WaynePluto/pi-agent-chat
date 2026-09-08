import type { ChatState } from "../shared/protocol.js";

/**
 * 宿主推送的最新状态快照。
 *
 * 宿主消息是完整快照，状态整体替换而非合并：这样可选字段（如已结束的
 * delegation）才会被清掉。以 live binding 导出——各模块直接读 `state.*`，
 * 只有 `setState()` 写。
 */
export let state: ChatState = { ready: false, isStreaming: false, isCompacting: false };

export function setState(next: ChatState): void {
  state = next;
}

/**
 * 此刻是否有子代理在跑。
 *
 * `state.delegation` 比运行活得久——lane 卡片保留最终计数、用户打开过的
 * lane 仍可读——因此它的存在绝不能读作「忙」。一切以活动为门槛的判断都
 * 问这里。
 */
export function isDelegating(): boolean {
  return Boolean(state.delegation?.running);
}

/** 当前显示的 transcript 是否属于某个子代理（运行中或已结束）。 */
export function isInLane(): boolean {
  return state.delegation?.role === "child";
}

/** 当前屏幕上的 lane，无则 undefined。 */
export function currentLane() {
  const delegation = state.delegation;
  if (delegation?.role !== "child") return undefined;
  return delegation.lanes.find((lane) => lane.id === delegation.currentLaneId);
}
