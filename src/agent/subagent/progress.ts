import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { LaneState } from "./types.js";

/**
 * 把子会话事件变成 UI 为该路显示的那一行。
 *
 * 父代理等待期间自己没有输出，进展感全靠这些行。返回 undefined 则
 * 保留上一行。
 */
export function describeProgress(event: AgentSessionEvent): string | undefined {
  if (event.type === "tool_execution_start") {
    const args = event.args as Record<string, unknown> | undefined;
    const path = typeof args?.path === "string" ? args.path : undefined;
    switch (event.toolName) {
      case "read":
        return path ? `reading ${path}` : "reading";
      case "edit":
        return path ? `editing ${path}` : "editing";
      case "write":
        return path ? `writing ${path}` : "writing";
      case "bash": {
        const command = typeof args?.command === "string" ? args.command : "";
        return `running ${command.length > 48 ? `${command.slice(0, 45)}...` : command || "a command"}`;
      }
      default:
        return event.toolName;
    }
  }
  if (event.type === "message_start") return "thinking...";
  return undefined;
}

export function progressLine(lanes: readonly LaneState[]): string {
  const done = lanes.filter((lane) => lane.status !== "running").length;
  return `Subagents: ${done}/${lanes.length} finished`;
}

export function snapshot(lane: LaneState) {
  return {
    id: lane.id,
    title: lane.title,
    scope: [...lane.scope],
    status: lane.status,
    failure: lane.failure,
    // 随卡片携带：运行期间这是「有东西在动」的唯一可见迹象。
    progress: lane.progress,
    summary: lane.summary,
    writtenFiles: [...lane.writtenFiles],
    scopeViolations: lane.scopeViolations,
    deniedPaths: [...lane.deniedPaths],
    bashMayHaveWritten: lane.bashMayHaveWritten,
    sessionFile: lane.sessionFile,
    durationMs: lane.endedAt ? lane.endedAt - lane.startedAt : undefined,
  };
}
