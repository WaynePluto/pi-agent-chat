import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TranscriptImage } from "../../shared/protocol.js";
import { invokedSkill } from "../skills.js";
import { stripImageAttachmentMarkup } from "../images.js";
import { userDisplayFromText } from "../session-title.js";
import type { PromptAttachment } from "./attachments.js";
import { peekAttachments, releaseAttachments } from "./attachments.js";
import type { ChatBridge } from "./chat-bridge.js";
import type { CompactionQueuedPrompt, QueuedImageRecord } from "./types.js";

/** 把宿主自己的压缩队列与 SDK 的常规队列合并展示，并对账排队附件。 */
export function emitCombinedQueueUpdate(
  bridge: ChatBridge,
  session: AgentSession,
  steering: readonly string[] = session.getSteeringMessages(),
  followUp: readonly string[] = session.getFollowUpMessages(),
): void {
  const local = bridge.compactionQueues.get(session.sessionId) ?? [];
  pruneQueuedImages(bridge, session, [...steering, ...followUp, ...local.map((item) => item.text)]);
  // 只投影展示副本：存下的文本是队列冲刷时重发给模型的正文，其标记必须原样保留。
  bridge.emit(session, {
    kind: "queue_update",
    steering: [
      ...steering.map(userDisplayFromText),
      ...local.filter((item) => item.mode === "steer").map((item) => userDisplayFromText(item.text)),
    ],
    followUp: [
      ...followUp.map(userDisplayFromText),
      ...local.filter((item) => item.mode === "followUp").map((item) => userDisplayFromText(item.text)),
    ],
  });
}

/**
 * 队列对账：SDK 每次变化都发 `queue_update`，不再在队列里的文本就是已被
 * 消费——其暂存附件随之释放。按共享显示投影比较（SDK 可能在排队时展开
 * 技能 / 模板）并计同文本次数：同一文本排队多次时逐条消耗，而不是一存俱存。
 */
function pruneQueuedImages(bridge: ChatBridge, session: AgentSession, remainingTexts: readonly string[]): void {
  const record = bridge.queuedImages.get(session.sessionId);
  if (!record || record.length === 0) return;
  const remaining = new Map<string, number>();
  for (const text of remainingTexts) {
    const key = userDisplayFromText(text);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const kept: QueuedImageRecord[] = [];
  for (const entry of record) {
    const count = remaining.get(userDisplayFromText(entry.text)) ?? 0;
    if (count > 0) {
      remaining.set(userDisplayFromText(entry.text), count - 1);
      kept.push(entry);
    } else {
      for (const id of entry.ids) bridge.pendingImages.delete(id);
    }
  }
  bridge.queuedImages.set(session.sessionId, kept);
}

/**
 * SDK 队列收到一条带附件的消息：登记文本与附件的对账，撤回时取回、消费
 * 时释放。返回创建的记录（同一对象也用于失败回滚时按引用移除）。
 */
export function recordQueuedImages(
  bridge: ChatBridge,
  session: AgentSession,
  text: string,
  attachments: PromptAttachment[],
): QueuedImageRecord | undefined {
  if (attachments.length === 0) return undefined;
  const record = bridge.queuedImages.get(session.sessionId) ?? [];
  const entry: QueuedImageRecord = { text, ids: attachments.map((item) => item.id) };
  record.push(entry);
  bridge.queuedImages.set(session.sessionId, record);
  return entry;
}

export function queueDuringCompaction(
  bridge: ChatBridge,
  session: AgentSession,
  text: string,
  mode: "steer" | "followUp",
  attachments: PromptAttachment[] = [],
): void {
  const queue = bridge.compactionQueues.get(session.sessionId) ?? [];
  queue.push({ text, mode, imageIds: attachments.map((item) => item.id) });
  bridge.compactionQueues.set(session.sessionId, queue);
  bridge.emit(session, {
    kind: "user_message",
    text: stripImageAttachmentMarkup(text),
    mode,
    skill: invokedSkill(bridge.skillIndex, text),
    images: attachments.length > 0 ? attachments.map(({ mimeType, data, name }) => ({ mimeType, data, name })) : undefined,
  });
  emitCombinedQueueUpdate(bridge, session);
}

function sdkImages(attachments: PromptAttachment[]): { type: "image"; mimeType: string; data: string }[] {
  return attachments.map(({ mimeType, data }) => ({ type: "image", mimeType, data }));
}

/**
 * 把压缩期间的提交转入 SDK 队列。手动压缩结束后无运行，首条排队消息
 * 负责启动一轮；自动压缩留在原运行内，各项直接接收。
 */
export async function flushCompactionQueue(
  bridge: ChatBridge,
  session: AgentSession,
  willRetry: boolean,
): Promise<void> {
  const sessionId = session.sessionId;
  const queued = [...(bridge.compactionQueues.get(sessionId) ?? [])];
  if (queued.length === 0) return;

  /* 本次冲刷已交给 SDK 队列的附件对账记录：失败回滚时随条目收回压缩
     队列，附件的所有权也一并回去（暂存 id 不动）。 */
  const handedOver: QueuedImageRecord[] = [];
  const restore = (items: CompactionQueuedPrompt[], error: unknown) => {
    bridge.compactionQueues.set(sessionId, items);
    const record = bridge.queuedImages.get(sessionId);
    if (record) {
      const kept = record.filter((entry) => !handedOver.includes(entry));
      if (kept.length > 0) bridge.queuedImages.set(sessionId, kept);
      else bridge.queuedImages.delete(sessionId);
    }
    session.clearQueue();
    bridge.reportError(session, "failed to send message queued during compaction", error);
    void bridge.postState();
  };

  /* 单条送达 SDK 队列：图片数据交给 SDK，id 留在暂存并登记对账——之后
     被消费（queue_update 不再含该文本）或被撤回时才释放。 */
  const deliver = async (item: CompactionQueuedPrompt): Promise<void> => {
    const images = peekAttachments(bridge, item.imageIds);
    if (item.mode === "followUp") await session.followUp(item.text, sdkImages(images));
    else await session.steer(item.text, sdkImages(images));
    const entry = recordQueuedImages(bridge, session, item.text, images);
    if (entry) handedOver.push(entry);
  };

  // 自动压缩属于进行中的运行（含溢出重试）。
  if (willRetry || session.isStreaming) {
    try {
      for (const item of queued) await deliver(item);
      bridge.compactionQueues.delete(sessionId);
      emitCombinedQueueUpdate(bridge, session);
    } catch (error) {
      restore(queued, error);
    }
    return;
  }

  // 手动压缩后没有活动的 agent 循环：首条排队消息作为普通 prompt 启动运行，preflight 成功后再转入其余各项。
  const [first, ...rest] = queued;
  if (!first) return;
  let resolvePreflight!: (success: boolean) => void;
  const preflight = new Promise<boolean>((resolve) => {
    resolvePreflight = resolve;
  });
  let started = false;
  let failed = false;
  const firstImages = peekAttachments(bridge, first.imageIds);
  const promptPromise = session
    .prompt(first.text, { preflightResult: resolvePreflight, images: sdkImages(firstImages) })
    .then(() => {
      // prompt 完成 = 首条已随运行进入会话（不是队列），附件不再需要暂存。
      releaseAttachments(bridge, firstImages);
    })
    .catch((error) => {
      failed = true;
      // preflight 之后失败：首条按既有语义被丢弃（不回队列），附件随之释放。
      if (started) releaseAttachments(bridge, firstImages);
      restore(started ? rest : queued, error);
    });

  const preflightSucceeded = await preflight;
  started = preflightSucceeded;
  if (!preflightSucceeded) {
    await promptPromise;
    return;
  }

  if (rest.length > 0) bridge.compactionQueues.set(sessionId, rest);
  else bridge.compactionQueues.delete(sessionId);
  emitCombinedQueueUpdate(bridge, session);
  try {
    for (const item of rest) {
      if (failed) return;
      await deliver(item);
    }
    if (!failed) {
      bridge.compactionQueues.delete(sessionId);
      emitCombinedQueueUpdate(bridge, session);
    }
  } catch (error) {
    failed = true;
    restore(rest, error);
  }
  void promptPromise.finally(() => bridge.postState());
}

/**
 * 丢弃 webview 为 live 会话排队的全部内容（"dequeue" 消息）：文本与图片
 * 附件退回 composer。SDK 队列只暴露文本，图片数据活在本宿主的暂存里，
 * 按 `queuedImages` 的对账记录逐条认领。
 */
export function dequeueAll(bridge: ChatBridge): void {
  const session = bridge.runtime.session;
  const record = bridge.queuedImages.get(session.sessionId) ?? [];
  const restored: { id: string; image: TranscriptImage }[] = [];
  /** 队列文本 → 撤回的附件；同一文本排队多次时逐条认领。 */
  const claimImages = (rawText: string): void => {
    const entry = record.find((item) => !item.claimed && userDisplayFromText(item.text) === userDisplayFromText(rawText));
    if (!entry) return;
    entry.claimed = true;
    for (const id of entry.ids) {
      const image = bridge.pendingImages.get(id);
      if (image) restored.push({ id, image: { mimeType: image.mimeType, data: image.data, name: image.name } });
    }
  };
  const sdkRaw = [...session.getSteeringMessages(), ...session.getFollowUpMessages()];
  const compacting = bridge.compactionQueues.get(session.sessionId) ?? [];
  const rawTexts = [...sdkRaw, ...compacting.map((item) => item.text)];
  if (rawTexts.length === 0) return;
  for (const rawText of rawTexts) claimImages(rawText);
  // 先告知 webview，让待定气泡在 clearQueue() 的 queue_update 到达之前移除
  // （否则它们会被当作已消费而钉进 transcript）。
  bridge.host.post({
    type: "dequeued",
    texts: rawTexts.map(userDisplayFromText),
    images: restored.length > 0 ? restored : undefined,
  });
  // 未被认领的暂存图片（消息已被消费或文本形态漂移）不再有归属，释放。
  for (const entry of record) {
    if (entry.claimed) continue;
    for (const id of entry.ids) bridge.pendingImages.delete(id);
  }
  bridge.queuedImages.delete(session.sessionId);
  bridge.compactionQueues.delete(session.sessionId);
  session.clearQueue();
}
