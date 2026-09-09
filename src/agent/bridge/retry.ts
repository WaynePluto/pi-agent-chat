import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ChatEvent, OfferKind, OfferState } from "../../shared/protocol.js";
import { t } from "../i18n.js";
import { isContinuable, isResumable, resumeStalledRun, supportsResume } from "../resume.js";
import type { ChatBridge } from "./chat-bridge.js";

/** 各提议的文案与判定：两种动作共享全部机制，只有措辞与事实源不同。 */
const OFFERS: Record<OfferKind, { text: () => string; unavailable: () => string }> = {
  retry: { text: () => t("retryInterrupted"), unavailable: () => t("retryUnavailable") },
  continue: { text: () => t("continueStopped"), unavailable: () => t("continueUnavailable") },
};

/**
 * 以一次「续跑」提议为停在半途的轮次收尾。挂在 agent_settled 而非
 * auto_retry_end 提示上：只有那里一切自动机制都已落定，状态稳定，一条
 * 规则盖住所有中断方式（自动重试放弃 / 被关掉 / 不可重试的错误 / 用户
 * 手动停止），一次中断恰好产出一个按钮、总在 transcript 末尾。失败优先
 * 用重试措辞、手动停止用继续措辞，按尾巴与实时事实取最新的那个。只给
 * 用户对话的那个会话：挂掉的 lane 汇报给父代理去决定，用户对子代理
 * 只有「看」和「停」。
 */
export function offerStalledAction(bridge: ChatBridge, session: AgentSession): void {
  if (session !== bridge.runtime.session || !supportsResume(session)) return;
  const liveFailure = bridge.liveFailedResponses.delete(session.sessionId);
  const liveAbort = bridge.liveAbortedResponses.delete(session.sessionId);
  /* isContinuable()/isResumable() 是持久 / 回放路径；live 集合是刚 settle
     那轮的 message_end 直接事实，补上可见中断先于 SessionManager 把它
     暴露为活动分支尾巴的小缺口。两条路径都不从展示文本猜测。 */
  let kind: OfferKind | undefined;
  if (liveAbort || isContinuable(session)) kind = "continue";
  else if (liveFailure || isResumable(session)) kind = "retry";
  if (kind) {
    bridge.emit(session, { kind: "status", text: OFFERS[kind].text(), offer: { kind, state: "offered" } });
  }
}

/**
 * 在存储的 history 事件本体上记录用户点击的提议的下场。动作的整个生命
 * 周期归宿主：webview 每次回放都从头重建 transcript，只知道自己被点过的
 * 按钮会在重试中段回来时仍可点，完成的提议也会一直声称还在跑。索引取
 * 运行前捕获的那个：再次失败的重试会在本条下方追加新提议（见
 * offerStalledAction），标最后一条会改错卡片。
 */
export function markOffer(
  bridge: ChatBridge,
  session: AgentSession,
  index: number,
  state: OfferState,
  sourceLeafId: string,
): void {
  const history = bridge.histories.get(session.sessionId);
  const event = history?.[index];
  if (!history || event?.kind !== "status" || !event.offer) return;
  const updated = { ...event, offer: { ...event.offer, state } };
  history[index] = updated;
  bridge.offerOutcomes.set(session.sessionId, { sourceLeafId, event: updated });
  if (bridge.isDisplayed(session)) bridge.postHistory();
}

/** 提议点击作用的索引：该 kind 最后一个仍可点击的。 */
export function liveOfferIndex(bridge: ChatBridge, session: AgentSession, offerKind: OfferKind): number {
  const history = bridge.histories.get(session.sessionId) ?? [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index];
    if (event?.kind === "status" && event.offer?.kind === offerKind && event.offer.state === "offered") return index;
  }
  return -1;
}

/**
 * 给为回放 transcript 合成的提议（见 withOffer）一个真实的 history
 * 落点，让它的下场有处安放。重开死在请求中途的会话的窗口看到的提议只
 * 存在于发给 webview 的副本里；不落点，点它什么都解决不了、按钮卡在
 * 重试中。点击时才追加而非每次回放追加，避免合成提议本要避免的累积：
 * 此后 withOffer 会找到这一条、不再新增。不单独发送——调用方随后
 * 的完整重放会带上它。
 */
export function materializeOffer(bridge: ChatBridge, session: AgentSession, offerKind: OfferKind): number {
  const events = bridge.histories.get(session.sessionId) ?? bridge.buildHistory(session);
  events.push({ kind: "status", text: OFFERS[offerKind].text(), scope: "command", offer: { kind: offerKind, state: "offered" } });
  bridge.histories.set(session.sessionId, events);
  return events.length - 1;
}

/** 该 kind 的提议此刻对会话是否成立（settle 出提议与回放重算共用，必须严格：
 * 两种尾巴互斥，宽口径会让同一轮长出两个按钮）。 */
function offerEligible(session: AgentSession, offerKind: OfferKind): boolean {
  return offerKind === "continue" ? isContinuable(session) : isResumable(session);
}

/**
 * 点击时的复核口径，比 offerEligible 宽：继续按钮可能在停止落在工具执行
 * 中间（尾巴 toolResult、仅实时事实可见）时发出，回放后重开再点，按
 * isResumable 的同一形状续跑照样成立。重试不放宽。
 */
function clickEligible(session: AgentSession, offerKind: OfferKind): boolean {
  return offerKind === "continue" ? isContinuable(session) || isResumable(session) : isResumable(session);
}

/** 发给 webview 的副本里是否已有仍在等待点击的该 kind 提议。 */
function hasPendingOffer(events: readonly ChatEvent[], offerKind: OfferKind): boolean {
  return events.some(
    (event) => event.kind === "status" && event.offer?.kind === offerKind && (event.offer.state === "offered" || event.offer.state === "running"),
  );
}

/**
 * 把提议重新接到正在回放的 transcript 上。提示是 transcript 事件，只
 * 存在于看着运行中断的窗口里；新窗口重开该会话，transcript 停在裸的
 * 供方错误（"Request timed out."）或被中止的半截回答上、无处可点——
 * 而让续跑有意义的状态本身还活在会话文件里（中断的响应仍是最后一条
 * 消息），故提议在回放时重算。只作用于发给 webview 的副本，绝不写进
 * 存储历史：写进去的合成提示会每次 attach 累积一条。
 */
export function withOffer(bridge: ChatBridge, session: AgentSession, events: readonly ChatEvent[]): ChatEvent[] {
  const copy = [...events];
  if (bridge.view.kind !== "live" || session !== bridge.runtime.session) return copy;
  for (const offerKind of ["retry", "continue"] as const) {
    if (!offerEligible(session, offerKind)) continue;
    if (hasPendingOffer(copy, offerKind)) continue;
    copy.push({ kind: "status", text: OFFERS[offerKind].text(), scope: "command", offer: { kind: offerKind, state: "offered" } });
  }
  return copy;
}

/**
 * 续跑停在半途的运行（提议卡片上的动作）。只有 live 父会话可续跑：另两
 * 个视图只读，lane 的中断轮次属于父会话拥有的运行。点击永远可能过期
 * ——提示留在 transcript 里——所以判定取自会话状态而非按钮。被点的提议
 * 随后在 transcript 上收敛：请求在途时 running，结束后 succeeded /
 * failed；下面两处拒绝都保持提议可点击，因为什么都没有重发。
 */
export async function runStalledAction(bridge: ChatBridge, offerKind: OfferKind): Promise<void> {
  if (bridge.view.kind !== "live") return;
  const session = bridge.runtime.session;
  // 已有东西在跑：这次点击扑空了，在明显重新动起来的 transcript 上再说话只是噪音。
  if (session.isStreaming || session.isCompacting) return;
  if (!clickEligible(session, offerKind)) {
    bridge.emit(session, { kind: "status", text: OFFERS[offerKind].unavailable() });
    await bridge.postState();
    return;
  }
  const known = liveOfferIndex(bridge, session, offerKind);
  const offer = known >= 0 ? known : materializeOffer(bridge, session, offerKind);
  const sourceLeafId = session.sessionManager.getLeafId();
  if (!sourceLeafId) return;
  const active = { offerKind, offerIndex: offer, sourceLeafId, succeeded: false };
  bridge.activeManualOffers.set(session.sessionId, active);
  markOffer(bridge, session, offer, "running", sourceLeafId);
  try {
    await resumeStalledRun(session);
    /* 终局答案可从已 settle 的分支推断，服务测试与不向本 bridge 投递消息
       事件的 SDK 路径；正常进行时，上面的 message_end 会更早收敛提议——
       包括工具请求后紧跟另一次供方失败或停止的情形。 */
    markOffer(
      bridge,
      session,
      offer,
      active.succeeded || !clickEligible(session, offerKind) ? "succeeded" : "failed",
      sourceLeafId,
    );
  } catch (error) {
    bridge.reportError(session, `${offerKind} failed`, error);
    markOffer(bridge, session, offer, active.succeeded ? "succeeded" : "failed", sourceLeafId);
  } finally {
    if (bridge.activeManualOffers.get(session.sessionId) === active) {
      bridge.activeManualOffers.delete(session.sessionId);
    }
    await bridge.postState();
  }
}
