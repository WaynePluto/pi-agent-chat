import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { invokedSkill } from "../skills.js";
import { userDisplayFromText } from "../session-title.js";
import type { ChatBridge } from "./chat-bridge.js";

/** 把宿主自己的压缩队列与 SDK 的常规队列合并展示。 */
export function emitCombinedQueueUpdate(
  bridge: ChatBridge,
  session: AgentSession,
  steering: readonly string[] = session.getSteeringMessages(),
  followUp: readonly string[] = session.getFollowUpMessages(),
): void {
  const local = bridge.compactionQueues.get(session.sessionId) ?? [];
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

export function queueDuringCompaction(
  bridge: ChatBridge,
  session: AgentSession,
  text: string,
  mode: "steer" | "followUp",
): void {
  const queue = bridge.compactionQueues.get(session.sessionId) ?? [];
  queue.push({ text, mode });
  bridge.compactionQueues.set(session.sessionId, queue);
  bridge.emit(session, { kind: "user_message", text, mode, skill: invokedSkill(bridge.skillIndex, text) });
  emitCombinedQueueUpdate(bridge, session);
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

  const restore = (items: { text: string; mode: "steer" | "followUp" }[], error: unknown) => {
    bridge.compactionQueues.set(sessionId, items);
    session.clearQueue();
    bridge.reportError(session, "failed to send message queued during compaction", error);
    void bridge.postState();
  };

  // 自动压缩属于进行中的运行（含溢出重试）。
  if (willRetry || session.isStreaming) {
    try {
      for (const item of queued) {
        if (item.mode === "followUp") await session.followUp(item.text);
        else await session.steer(item.text);
      }
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
  const promptPromise = session
    .prompt(first.text, { preflightResult: resolvePreflight })
    .catch((error) => {
      failed = true;
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
      if (item.mode === "followUp") await session.followUp(item.text);
      else await session.steer(item.text);
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

/** 丢弃 webview 为 live 会话排队的全部内容（"dequeue" 消息）。 */
export function dequeueAll(bridge: ChatBridge): void {
  const session = bridge.runtime.session;
  const sdkQueued = [...session.getSteeringMessages(), ...session.getFollowUpMessages()].map(userDisplayFromText);
  const compactingQueued = bridge.compactionQueues.get(session.sessionId) ?? [];
  const queued = [...sdkQueued, ...compactingQueued.map((item) => userDisplayFromText(item.text))];
  if (queued.length > 0) {
    // 先告知 webview，让待定气泡在 clearQueue() 的 queue_update 到达之前移除
    // （否则它们会被当作已消费而钉进 transcript）。
    bridge.host.post({ type: "dequeued", texts: queued });
    bridge.compactionQueues.delete(session.sessionId);
    session.clearQueue();
  }
}
