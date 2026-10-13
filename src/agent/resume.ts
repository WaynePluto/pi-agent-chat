import type { AgentSession, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

/**
 * 续跑被打断的那一轮请求（自动重试放弃的失败，或用户手动停止），
 * 不替用户编造任何话。停止或重试放弃后，继续的办法曾是打一句「继续」
 * ——那条消息与任务无关却进了上下文。resume 原样重发同一请求。
 *
 * SDK-MIRROR: `core/agent-session.ts`，复刻自动重试的两步：把中断的响应
 * 持久化地从模型上下文忽略（`appendContextEdit(id, null)`——0.87.0 起
 * SDK 自动重试放弃一次尝试时写的就是它；原始 transcript 保留显示，
 * 供应商拒绝空 assistant 结尾）；再以空起始消息批走私有 `_startRun`
 * ——外层循环管 streaming、重试、压缩与 settle，直调 agent 则 UI 永远等
 * 不到 settle。0.87.0 起 provider 上下文一律取自 SessionManager 的规范
 * 投影（`prepareRequest` 每次请求整体替换消息），改写 `agent.state.messages`
 * 对请求已无效果——丢弃若不走持久化忽略，恢复的首个请求就会带着空
 * assistant 结尾发给供应商。1.2.0 起 `_startRun` 吸并了旧 `_runAgentPrompt`
 * 的调用形状：起始消息批改由 `_prepareRun(trigger)` 构造，而两种 trigger
 * 都至少新增一条消息，空批续跑只能置换首次 `_prepareRun`（见
 * `runEmptyBatch()`）；后续 resume 机制不变。
 */

/** 上述私有运行入口的形状（1.2.0 起 `_startRun` + `_prepareRun`）。 */
interface SessionRunner {
  _startRun(trigger: unknown, onStarted?: () => void): Promise<void>;
  _prepareRun(trigger: unknown): Promise<unknown[]>;
}

function runner(session: AgentSession): SessionRunner | undefined {
  const candidate = session as unknown as Partial<SessionRunner>;
  return typeof candidate._startRun === "function" && typeof candidate._prepareRun === "function"
    ? (candidate as SessionRunner)
    : undefined;
}

/** 本宿主能否 resume 一轮失败的会话（SDK 机制是否存在）。 */
export function supportsResume(session: AgentSession): boolean {
  return runner(session) !== undefined;
}

/**
 * 以空起始消息批跑一轮 `_startRun`。
 *
 * 置换只吃掉第一次 `_prepareRun`：本次运行的 settle 期间排队的真实
 * prompt 会经 deferred settled action 重入 `prompt()` → `_startRun`，
 * 必须仍走原始消息构造，否则用户那条消息会被静默换成空批。
 */
async function runEmptyBatch(session: AgentSession, run: SessionRunner): Promise<void> {
  let first = true;
  const prepare = run._prepareRun;
  const stub = async (trigger: unknown): Promise<unknown[]> => {
    if (first) {
      first = false;
      return [];
    }
    return prepare.call(session, trigger);
  };
  (session as unknown as SessionRunner)._prepareRun = stub;
  try {
    // trigger 只是 `_prepareRun` 的入参，已被置换消费，形状不再被读到。
    await run._startRun.call(session, { messageType: "custom", message: null });
  } finally {
    if ((session as unknown as SessionRunner)._prepareRun === stub) {
      delete (session as unknown as { _prepareRun?: SessionRunner["_prepareRun"] })._prepareRun;
    }
  }
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
  await runEmptyBatch(session, run);
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
