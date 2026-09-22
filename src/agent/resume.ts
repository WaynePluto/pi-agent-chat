import type { AgentSession, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

/**
 * 续跑被打断的那一轮请求（自动重试放弃的失败，或用户手动停止），
 * 不替用户编造任何话。停止或重试放弃后，继续的办法曾是打一句「继续」
 * ——那条消息与任务无关却进了上下文。resume 原样重发同一请求。
 *
 * SDK-MIRROR: `core/agent-session.ts`，复刻自动重试的两步：把中断的响应
 * 持久化地从模型上下文忽略（`appendContextEdit(id, null)`——0.87.0 起
 * SDK 自动重试放弃一次尝试时写的就是它；原始 transcript 保留显示，
 * 供应商拒绝空 assistant 结尾）；以空批走私有 `_runAgentPrompt`——外层
 * 循环管 streaming、重试、压缩与 settle，直调 agent 则 UI 永远等不到
 * settle。0.87.0 起 provider 上下文一律取自 SessionManager 的规范投影
 * （`prepareRequest` 每次请求整体替换消息），改写 `agent.state.messages`
 * 对请求已无效果——丢弃若不走持久化忽略，恢复的首个请求就会带着空
 * assistant 结尾发给供应商。
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
 * 规范投影刻意不总等于原始 transcript：Pi 自动重试放弃一次尝试时会把
 * 那条 assistant 错误持久化地从模型上下文忽略（原始历史保留）；请求在
 * 产出 assistant 响应前抛错时，分支尾巴可能是 user/toolResult。两者都
 * 能用同一空批 prompt 路径 resume。正常结束的响应绝不做候选——重发它
 * 会悄悄丢掉屏幕上的答案。
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
 * 活动分支是否停在用户手动停止的那一轮上（尾巴是被中止的 assistant
 * 响应）。仅此形状给「继续」提议：停止落在工具执行中间时尾巴是
 * toolResult，由 `isResumable()` 的既有形状盖住。
 */
export function isContinuable(session: AgentSession): boolean {
  if (session.isStreaming || session.isCompacting) return false;
  if (!supportsResume(session)) return false;
  const messages = session.sessionManager.buildSessionContext().messages;
  const last = messages[messages.length - 1];
  return last?.role === "assistant" && last.stopReason === "aborted";
}

/**
 * 续跑停在半途的那一轮（失败或被停止）。等续跑的运行 settle 后 resolve；
 * 会话若已越过那次中断则返回 false。
 */
export async function resumeStalledRun(session: AgentSession): Promise<boolean> {
  const run = runner(session);
  if (!run || !(isResumable(session) || isContinuable(session))) return false;
  const messages = session.sessionManager.buildSessionContext().messages;
  const last = messages[messages.length - 1];
  // 供应商无法从空的失败/被中止 assistant 响应继续。SDK 的自动重试在重试
  // 前已把失败尝试持久化忽略，抛错的请求则根本没产出；只有规范投影确实
  // 停在那条响应上时才补一次忽略。被停止的响应照丢：transcript 上已显示
  // 的半截回答不受影响，但模型从上一条完好消息重新发起那一轮。
  if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
    omitFromProviderContext(session, last);
  }
  await run.call(session, []);
  return true;
}

/**
 * 把一条已被放弃的响应持久化地从模型上下文移除，并重建派生的 agent
 * state。SDK-MIRROR: `core/agent-session.ts` 的 `_omitRecoveryAttempt()` /
 * `_findPersistedMessageEntryId()`——按消息对象身份在活动分支里反查其
 * 持久化条目，再写一条 `context_edit`（`replacement: null`）。找不到条目
 * （正常不会发生：state 与投影共享同一批消息对象）时不忽略照发，让请求
 * 自己把问题暴露出来——静默编造不出可写的目标。
 */
function omitFromProviderContext(session: AgentSession, message: SessionMessageEntry["message"]): void {
  for (const entry of [...session.sessionManager.getBranch()].reverse()) {
    if (entry.type === "message" && entry.message === message) {
      session.sessionManager.appendContextEdit(entry.id, null);
      session.refreshContext();
      return;
    }
  }
}
