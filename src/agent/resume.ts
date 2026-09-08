import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * 重发被打断的那一轮请求，不替用户编造任何话。自动重试放弃后
 * transcript 停在一条从未到达的响应上；继续的办法曾是打一句「继续」
 * ——那条消息与任务无关却进了上下文。resume 原样重发同一请求。
 *
 * SDK-MIRROR: `core/agent-session.ts`，复刻自动重试的两步：只从 agent
 * state 丢失败响应（会话文件保留——供应商拒绝空 assistant 结尾）；
 * 以空批走私有 `_runAgentPrompt`——外层循环管 streaming、重试、压缩与
 * settle，直调 agent 则 UI 永远等不到 settle。
 */

/** 上述私有 prompt 路径的形状。 */
interface SessionRunner {
  _runAgentPrompt(messages: unknown[]): Promise<void>;
}

function runner(session: AgentSession): SessionRunner["_runAgentPrompt"] | undefined {
  const candidate = (session as unknown as Partial<SessionRunner>)._runAgentPrompt;
  return typeof candidate === "function" ? candidate : undefined;
}

/** 本宿主能否 resume 一轮失败的会话（SDK 机制是否存在）。 */
export function supportsResume(session: AgentSession): boolean {
  return runner(session) !== undefined;
}

/**
 * 活动分支是否停在「已发出但从未完成」的一轮上。
 *
 * 持久化分支刻意不总等于 `agent.state.messages`：Pi 自动重试前会把
 * assistant 错误从 agent state 移除但留在会话历史；请求在产出 assistant
 * 响应前抛错时，分支尾巴可能是 user/toolResult。两者都能用同一空批
 * prompt 路径 resume。正常结束或被中止的响应绝不做候选——重发它会
 * 悄悄丢掉答案（或撤销用户明确的停止）。
 */
export function isResumable(session: AgentSession): boolean {
  if (session.isStreaming || session.isCompacting) return false;
  if (!supportsResume(session)) return false;
  const messages = session.sessionManager.buildSessionContext().messages;
  const last = messages[messages.length - 1];
  return (
    (last?.role === "assistant" && last.stopReason === "error") ||
    last?.role === "user" ||
    last?.role === "toolResult"
  );
}

/**
 * 重发被打断的那一轮。等 resume 的运行 settle 后 resolve；
 * 会话若已越过那次失败则返回 false。
 */
export async function resumeAfterError(session: AgentSession): Promise<boolean> {
  const run = runner(session);
  if (!run || !isResumable(session)) return false;
  const messages = session.agent.state.messages;
  const last = messages[messages.length - 1];
  // 供应商无法从空的失败 assistant 响应继续。Pi 的自动重试可能已经把它
  // 移除，或抛错的请求根本没产出；只有它确实是 agent state 尾巴时才丢。
  if (last?.role === "assistant" && last.stopReason === "error") {
    session.agent.state.messages = messages.slice(0, -1);
  }
  await run.call(session, []);
  return true;
}
