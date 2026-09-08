import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ChatEvent, RetryOfferState } from "../../shared/protocol.js";
import { t } from "../i18n.js";
import { isResumable, resumeAfterError, supportsResume } from "../resume.js";
import type { ChatBridge } from "./chat-bridge.js";

/**
 * 以「重发一次」的提议为停在失败请求上的轮次收尾。挂在 agent_settled
 * 而非 auto_retry_end 提示上：只有那里一切自动机制都已落定，状态稳定，
 * 一条规则盖住所有失败方式（自动重试放弃 / 被关掉 / 不可重试），一次
 * 失败恰好产出一个按钮、总在 transcript 末尾。只给用户对话的那个会话：
 * 挂掉的 lane 汇报给父代理去决定，用户对子代理只有「看」和「停」。
 */
export function offerRetry(bridge: ChatBridge, session: AgentSession): void {
  const liveFailure = bridge.liveFailedResponses.delete(session.sessionId);
  if (session !== bridge.runtime.session || !supportsResume(session)) return;
  /* isResumable() 是持久 / 回放路径；liveFailure 是刚 settle 那轮的
     message_end 直接事实，补上可见供方错误先于 SessionManager 把它暴露为
     活动分支尾巴的小缺口。两条路径都不从展示文本猜测。 */
  if (!liveFailure && !isResumable(session)) return;
  bridge.emit(session, { kind: "status", text: t("retryInterrupted"), retry: "offered" });
}

/**
 * 在存储的 history 事件本体上记录用户点击的提议的下场。动作的整个生命
 * 周期归宿主：webview 每次回放都从头重建 transcript，只知道自己被点过的
 * 按钮会在重试中段回来时仍可点，完成的提议也会一直声称还在跑。索引取
 * 运行前捕获的那个：再次失败的重试会在本条下方追加新提议（见
 * offerRetry），标最后一条会改错卡片。
 */
export function markRetryOffer(
  bridge: ChatBridge,
  session: AgentSession,
  index: number,
  state: RetryOfferState,
  sourceLeafId: string,
): void {
  const history = bridge.histories.get(session.sessionId);
  const event = history?.[index];
  if (!history || event?.kind !== "status" || !event.retry) return;
  const updated = { ...event, retry: state };
  history[index] = updated;
  bridge.retryOutcomes.set(session.sessionId, { sourceLeafId, event: updated });
  if (bridge.isDisplayed(session)) bridge.postHistory();
}

/** 重试点击作用的提议索引：最后一个仍可点击的。 */
export function liveRetryOffer(bridge: ChatBridge, session: AgentSession): number {
  const history = bridge.histories.get(session.sessionId) ?? [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index];
    if (event?.kind === "status" && event.retry === "offered") return index;
  }
  return -1;
}

/**
 * 给为回放 transcript 合成的提议（见 withRetryOffer）一个真实的 history
 * 落点，让它的下场有处安放。重开死在请求中途的会话的窗口看到的提议只
 * 存在于发给 webview 的副本里；不落点，点它什么都解决不了、按钮卡在
 * 重试中。点击时才追加而非每次回放追加，避免合成提议本要避免的累积：
 * 此后 withRetryOffer 会找到这一条、不再新增。不单独发送——调用方随后
 * 的完整重放会带上它。
 */
export function materializeRetryOffer(bridge: ChatBridge, session: AgentSession): number {
  const events = bridge.histories.get(session.sessionId) ?? bridge.buildHistory(session);
  events.push({ kind: "status", text: t("retryInterrupted"), scope: "command", retry: "offered" });
  bridge.histories.set(session.sessionId, events);
  return events.length - 1;
}

/**
 * 把提议重新接到正在回放的 transcript 上。上面那条提示是 transcript
 * 事件，只存在于看着运行失败的窗口里；新窗口重开该会话，transcript 停
 * 在裸的供方错误（"Request timed out."）上、无处可点——而让重试有意义的
 * 状态本身还活在会话文件里（失败响应仍是最后一条消息），故提议在回放
 * 时重算。只作用于发给 webview 的副本，绝不写进存储历史：写进去的合成
 * 提示会每次 attach 累积一条。
 */
export function withRetryOffer(bridge: ChatBridge, session: AgentSession, events: readonly ChatEvent[]): ChatEvent[] {
  const copy = [...events];
  if (bridge.view.kind !== "live" || session !== bridge.runtime.session) return copy;
  if (!isResumable(session)) return copy;
  // 已有提议：本窗口就是看到运行失败的那个，提示已在它的内存历史里。
  if (
    copy.some(
      (event) => event.kind === "status" && (event.retry === "offered" || event.retry === "running"),
    )
  ) return copy;
  copy.push({ kind: "status", text: t("retryInterrupted"), scope: "command", retry: "offered" });
  return copy;
}

/**
 * 重发自动重试已放弃的请求（「重试失败」提示上的重试动作）。只有 live
 * 父会话可 resume：另两个视图只读，lane 的失败轮次属于父会话拥有的
 * 运行。点击永远可能过期——提示留在 transcript 里——所以判定取自会话
 * 状态而非按钮。被点的提议随后在 transcript 上收敛：请求在途时
 * running，结束后 succeeded / failed；下面两处拒绝都保持提议可点击，
 * 因为什么都没有重发。
 */
export async function retryFailedRequest(bridge: ChatBridge): Promise<void> {
  if (bridge.view.kind !== "live") return;
  const session = bridge.runtime.session;
  // 已有东西在跑：这次点击扑空了，在明显重新动起来的 transcript 上再说话只是噪音。
  if (session.isStreaming || session.isCompacting) return;
  if (!isResumable(session)) {
    bridge.emit(session, { kind: "status", text: t("retryUnavailable") });
    await bridge.postState();
    return;
  }
  const known = liveRetryOffer(bridge, session);
  const offer = known >= 0 ? known : materializeRetryOffer(bridge, session);
  const sourceLeafId = session.sessionManager.getLeafId();
  if (!sourceLeafId) return;
  const active = { offerIndex: offer, sourceLeafId, succeeded: false };
  bridge.activeManualRetries.set(session.sessionId, active);
  markRetryOffer(bridge, session, offer, "running", sourceLeafId);
  try {
    await resumeAfterError(session);
    /* 终局答案可从已 settle 的分支推断，服务测试与不向本 bridge 投递消息
       事件的 SDK 路径；正常进行时，上面的 message_end 会更早收敛提议——
       包括工具请求后紧跟另一次供方失败的情形。 */
    markRetryOffer(
      bridge,
      session,
      offer,
      active.succeeded || !isResumable(session) ? "succeeded" : "failed",
      sourceLeafId,
    );
  } catch (error) {
    bridge.reportError(session, "retry failed", error);
    markRetryOffer(bridge, session, offer, active.succeeded ? "succeeded" : "failed", sourceLeafId);
  } finally {
    if (bridge.activeManualRetries.get(session.sessionId) === active) {
      bridge.activeManualRetries.delete(session.sessionId);
    }
    await bridge.postState();
  }
}
