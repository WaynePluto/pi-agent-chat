/**
 * 排队 / 插话消息撤回时图片附件的自检。
 *
 * 上报的 bug：撤回（dequeue）只把文本退回 composer，带图的排队消息图片
 * 直接消失。根因是 SDK 队列 API 只暴露文本（`getSteeringMessages()` 返回
 * `string[]`，图片数据活在其私有队列里），压缩队列又只存 `{text, mode}`。
 * 修复后的账是：附件在入队时不消费、留在宿主暂存（`pendingImages`）——SDK
 * 队列登记文本对账（`queuedImages`），压缩队列条目自带 id；撤回时各自认领
 * 退回、消费时（queue_update 不再含该文本）释放。这里经真实
 * `ChatBridge.handleMessage()` 钉住整条路：附加 → 排队（SDK 队列与压缩队列
 * 两条）→ 撤回带回图片（压缩队列在冲刷前后两个时刻）；以及消费后释放。
 */
import { ChatBridge } from "../bridge.js";
import { flushCompactionQueue } from "../bridge/compaction-queue.js";
import { OriginalContentProvider } from "../diff-view.js";
import { describe } from "../errors.js";
import { PiRuntime } from "../runtime.js";
import type { HostMessage } from "../../shared/protocol.js";
import type { DiagnosticResult } from "../diagnostics.js";
import { probePng, type StoredMessage } from "./shared.js";

export async function runQueueRecallTest(cwd: string): Promise<DiagnosticResult[]> {
  let runtime: PiRuntime | undefined;
  const failures: string[] = [];
  const expect = (label: string, ok: boolean) => {
    if (!failures.includes(label) && !ok) failures.push(label);
  };
  try {
    const posted: HostMessage[] = [];
    runtime = await PiRuntime.create({ cwd, log: () => {} });
    const bridge = new ChatBridge(
      runtime,
      { post: (message) => posted.push(message), log: () => {} },
      new OriginalContentProvider(),
    );
    await bridge.attach();
    const session = runtime.session;

    /** 宿主侧把一张真图附加进 composer，返回处理后的 id 与数据。 */
    const attach = async (): Promise<{ id: string; data: string } | undefined> => {
      const requestCount = posted.filter((message) => message.type === "attachment").length;
      await bridge.handleMessage({
        type: "attachImage",
        requestId: requestCount + 1,
        mimeType: "image/png",
        data: probePng(4, 4).toString("base64"),
      });
      for (let i = posted.length - 1; i >= 0; i -= 1) {
        const message = posted[i];
        if (message?.type === "attachment" && message.id && message.image) return { id: message.id, data: message.image.data };
      }
      return undefined;
    };
    const lastDequeued = () => {
      for (let i = posted.length - 1; i >= 0; i -= 1) {
        const message = posted[i];
        if (message?.type === "dequeued") return message;
      }
      return undefined;
    };

    /* --- 流式队列（steer / follow-up）：SDK 队列路径。--- */
    const first = await attach();
    expect("queued recall: image attached", first !== undefined);
    if (first) {
      Object.defineProperty(session, "isStreaming", { get: () => true, configurable: true });
      await bridge.handleMessage({ type: "prompt", text: "look at this", imageIds: [first.id], streamingBehavior: "followUp" });
      delete (session as { isStreaming?: boolean }).isStreaming;
      expect("sdk queue: message queued", session.getFollowUpMessages().length === 1);
      expect("sdk queue: attachment stays in the host store", bridge.pendingImages.has(first.id));
      const record = bridge.queuedImages.get(session.sessionId) ?? [];
      expect("sdk queue: reconciliation record written", record.length === 1 && record[0]!.ids.includes(first.id));
      const bubble = [...posted]
        .reverse()
        .map((message) => (message?.type === "event" ? message.event : undefined))
        .find((event) => event?.kind === "user_message") as { images?: unknown[] } | undefined;
      expect("sdk queue: bubble shows the image", bubble !== undefined && bubble.images?.length === 1);

      await bridge.handleMessage({ type: "dequeue" });
      const dequeued = lastDequeued();
      expect(
        "sdk queue: recall returns text and image",
        dequeued !== undefined &&
          dequeued.texts.length === 1 &&
          dequeued.texts[0] === "look at this" &&
          dequeued.images?.length === 1 &&
          dequeued.images[0]!.id === first.id &&
          dequeued.images[0]!.image.data === first.data,
      );
      expect("sdk queue: queue emptied", session.getFollowUpMessages().length === 0 && session.getSteeringMessages().length === 0);
      expect("sdk queue: recalled id is live again (composer owns it)", bridge.pendingImages.has(first.id));
      expect("sdk queue: reconciliation record consumed", (bridge.queuedImages.get(session.sessionId) ?? []).length === 0);
    }

    /* --- 压缩队列：宿主持有的应用层队列，撤回同样要带回图片。--- */
    const second = await attach();
    expect("compaction queue: image attached", second !== undefined);
    if (second) {
      Object.defineProperty(session, "isCompacting", { get: () => true, configurable: true });
      await bridge.handleMessage({ type: "prompt", text: "during compaction", imageIds: [second.id], streamingBehavior: "followUp" });

      /* 冲刷前撤回：压缩仍在进行，条目与附件 id 都还在宿主手里，图片必须
         随文本退回 composer（按 id 认领，不经文本对账）。 */
      await bridge.handleMessage({ type: "dequeue" });
      const preFlush = lastDequeued();
      expect(
        "compaction queue: recall returns the image while still compacting",
        preFlush !== undefined &&
          preFlush.texts.length === 1 &&
          preFlush.texts[0] === "during compaction" &&
          preFlush.images?.length === 1 &&
          preFlush.images[0]!.id === second.id,
      );
      expect("compaction queue: recalled id is live again", bridge.pendingImages.has(second.id));
      expect("compaction queue: host queue emptied", (bridge.compactionQueues.get(session.sessionId) ?? []).length === 0);

      /* 重新排队同一条消息（撤回的 id 已回 composer，可复用），再走冲刷路径。 */
      await bridge.handleMessage({ type: "prompt", text: "during compaction", imageIds: [second.id], streamingBehavior: "followUp" });
      delete (session as { isCompacting?: boolean }).isCompacting;
      const entry = (bridge.compactionQueues.get(session.sessionId) ?? [])[0];
      expect("compaction queue: entry keeps the attachment id", entry !== undefined && entry.imageIds.includes(second.id));
      expect("compaction queue: attachment stays in the host store", bridge.pendingImages.has(second.id));

      /* 冲刷把它交给 SDK 队列后，撤回仍要找得到（所有权随对账记录移交）。 */
      await flushCompactionQueue(bridge, session, true);
      expect("compaction queue: flushed into the sdk queue", session.getFollowUpMessages().length === 1);
      expect("compaction queue: reconciliation handed over", (bridge.queuedImages.get(session.sessionId) ?? []).length === 1);

      await bridge.handleMessage({ type: "dequeue" });
      const postFlush = lastDequeued();
      expect(
        "compaction queue: recall returns the image after flush",
        postFlush !== undefined && postFlush.images?.length === 1 && postFlush.images[0]!.id === second.id,
      );
      expect("compaction queue: queue emptied", session.getFollowUpMessages().length === 0);
    }

    /* --- 消费即释放：queue_update 不再含该文本时，暂存图片随之释放。--- */
    const third = await attach();
    expect("consumption: image attached", third !== undefined);
    if (third) {
      Object.defineProperty(session, "isStreaming", { get: () => true, configurable: true });
      await bridge.handleMessage({ type: "prompt", text: "will be consumed", imageIds: [third.id], streamingBehavior: "steer" });
      delete (session as { isStreaming?: boolean }).isStreaming;
      expect("consumption: queued with the attachment kept", session.getSteeringMessages().length === 1 && bridge.pendingImages.has(third.id));
      // clearQueue 发出的 queue_update 与消费走同一条对账路：文本离开队列，
      // 附件必须被释放，否则暂存会随会话寿命泄漏。
      session.clearQueue();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect("consumption: attachment released", !bridge.pendingImages.has(third.id));
      expect("consumption: reconciliation record pruned", (bridge.queuedImages.get(session.sessionId) ?? []).length === 0);
    }

    /* --- 回溯：带图消息送回 composer 时图片随行（entryAction switch）。--- */
    const fourth = await attach();
    expect("rewind: image attached", fourth !== undefined);
    if (fourth) {
      const manager = session.sessionManager;
      manager.appendMessage({
        role: "user",
        content: [
          { type: "text", text: "rewind me\n\n<image name=\"shot.png\"></image>" },
          { type: "image", mimeType: "image/png", data: fourth.data },
        ],
        timestamp: Date.now(),
      } as StoredMessage);
      const entry = [...manager.getBranch()].at(-1);
      expect("rewind: entry appended", entry !== undefined);
      if (entry) {
        // navigateTree 对「目标即叶子」是 no-op（不返回 editorText）；真实
        // 回溯总是指向更早的消息，补一条回应把目标变成历史条目。
        manager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          api: "anthropic-messages",
          provider: "probe-provider",
          model: "probe-model",
          usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        } as StoredMessage);
        await bridge.handleMessage({ type: "entryAction", action: "switch", entryId: entry.id });
        const setInput = [...posted].reverse().find((message) => message?.type === "setInput");
        expect(
          "rewind: composer gets text and image",
          setInput !== undefined &&
            setInput.type === "setInput" &&
            setInput.text === "rewind me" &&
            setInput.images?.length === 1 &&
            setInput.images[0]!.image.name === "shot.png" &&
            setInput.images[0]!.image.data === fourth.data &&
            bridge.pendingImages.has(setInput.images[0]!.id),
        );
        // 预填必须发生在 attach 之后（attach 清空附件暂存）：新 id 属于
        // 重新登记，而不是附加时的旧 id——先登记后 attach 会把它抹掉。
        expect("rewind: re-registered under a fresh id", setInput !== undefined && setInput.type === "setInput" && setInput.images?.[0]?.id !== fourth.id);
      }
    }

    bridge.dispose();
    return [
      {
        name: "queue recall",
        ok: failures.length === 0,
        detail: failures.length === 0
          ? "queued messages recall with their images (sdk queue, compaction queue pre- and post-flush); consumed queues release theirs"
          : `failed: ${failures.join("; ")}`,
      },
      {
        name: "rewind attachments",
        ok: failures.length === 0,
        detail: failures.length === 0
          ? "switching back to a user message with images restores them to the composer"
          : `failed: ${failures.join("; ")}`,
      },
    ];
  } catch (error) {
    return [{ name: "queue recall", ok: false, detail: describe(error) }];
  } finally {
    runtime?.dispose();
  }
}
