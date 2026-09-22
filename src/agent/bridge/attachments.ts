import { MAX_IMAGE_ATTACHMENTS, type TranscriptImage } from "../../shared/protocol.js";
import { t } from "../i18n.js";
import {
  attachmentName,
  prepareImage,
  MAX_ATTACHMENT_BYTES,
} from "../images.js";
import type { ChatBridge } from "./chat-bridge.js";

/** 一条 prompt 声明的附件，连同它在宿主暂存里的 id。 */
export interface PromptAttachment {
  id: string;
  name: string;
  mimeType: string;
  data: string;
  hints: string[];
}

/**
 * 处理一张粘贴 / 拖入的图片并交回 composer。在附加时而非发送时处理：
 * 拒绝（非图片、过大、无法缩放）能在用户还在编辑时冒出来，chip 展示的
 * 也是模型将实际收到的处理结果。两种情况只提示不阻断：无视觉能力的
 * 模型（用户可能发送前换模型）与共享设置 `images.blockImages`（SDK 会在
 * 送往供应商的路上把图片换成占位符——不说破，用户会以为模型看到了截图）。
 */
export async function attachImage(
  bridge: ChatBridge,
  requestId: number,
  request: { name?: string; mimeType?: string; data?: string },
): Promise<void> {
  const result = await prepareAttachment(bridge, request);
  if ("error" in result) return void bridge.host.post({ type: "attachment", requestId, error: result.error });
  bridge.host.post({ type: "attachment", requestId, id: result.id, image: result.image, note: attachmentNote(bridge) });
}

/** 读取、嗅探并处理一个粘贴附件。 */
async function prepareAttachment(
  bridge: ChatBridge,
  request: {
    name?: string;
    mimeType?: string;
    data?: string;
  },
): Promise<{ id: string; image: TranscriptImage } | { error: string }> {
  if (bridge.pendingImages.size >= MAX_IMAGE_ATTACHMENTS) return { error: t("imageTooMany") };
  if (request.data === undefined) return { error: t("imageUnsupported") };

  // 声明的类型不算证据：`prepareImage` 解码字节，photon 读不出的都拒。
  const bytes = Buffer.from(request.data, "base64");
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return { error: t("imageTooLarge") };

  // 官方配置优先：附加时就用当前模型的 per-model 缩放 profile（与 SDK
  // 在 prompt() 内部的归一化同源），发送时那层因此通常是空操作。附加后
  // 换模型（包括扩展在 before_agent_start 改模型）由 SDK 兜底重缩——
  // 与下面无视觉警告同属「提示不阻断」的宽容度。
  const resizeProfile = bridge.runtime.session.model?.inputLimits?.images?.resize;
  const prepared = await prepareImage(bytes, request.mimeType ?? "", bridge.runtime.settingsManager.getImageAutoResize(), resizeProfile);
  if (!prepared.ok) return { error: prepared.message };

  const id = `image-${++bridge.nextAttachmentId}`;
  const name = attachmentName(bridge.nextAttachmentId, request.name);
  bridge.pendingImages.set(id, { name, ...prepared.image });
  return { id, image: { mimeType: prepared.image.mimeType, data: prepared.image.data, name } };
}

/** 发送前用户应当知道的条件（若有）。 */
function attachmentNote(bridge: ChatBridge): string | undefined {
  if (bridge.runtime.settingsManager.getBlockImages()) return t("imageBlockedBySettings");
  const model = bridge.runtime.session.model;
  if (model && !model.input.includes("image")) return t("imageModelNoVision");
  return undefined;
}

/**
 * 按 composer 展示的顺序，读取一次 prompt 声明的附件——不消费：消息若落
 * 进排队（steer / follow-up / 压缩队列），附件留在暂存里，撤回时才能退回
 * composer；何时释放由发送路径按归宿决定（立即送达即释放，入队则随消费
 * 或撤回释放，见 `releaseAttachments` 与 `compaction-queue.ts`）。
 */
export function peekAttachments(bridge: ChatBridge, ids?: string[]): PromptAttachment[] {
  if (!ids?.length) return [];
  const taken: PromptAttachment[] = [];
  for (const id of ids.slice(0, MAX_IMAGE_ATTACHMENTS)) {
    const image = bridge.pendingImages.get(id);
    if (!image) continue;
    taken.push({ id, ...image });
  }
  return taken;
}

/** 附件随消息送达（或该次提交被放弃），从宿主暂存中移除。 */
export function releaseAttachments(bridge: ChatBridge, attachments: PromptAttachment[]): void {
  for (const attachment of attachments) bridge.pendingImages.delete(attachment.id);
}

/**
 * 回溯 / 分叉从会话条目送回 composer 的历史附件：字节是模型已见过的
 * SDK 存量（无需重新处理），重新登记进暂存拿到新 id，chip 的移除与再
 * 次发送从此走正常账。hints 留空：重发时 SDK 会按当前模型重新归一化，
 * 并在 `<image>` 标记之外附上自己的坐标说明（与「附加后换模型」同一
 * 兜底）。
 */
export function requeueSessionAttachments(
  bridge: ChatBridge,
  images: readonly { mimeType: string; data: string; name?: string }[] | undefined,
): { id: string; image: TranscriptImage }[] | undefined {
  if (!images?.length) return undefined;
  const restored: { id: string; image: TranscriptImage }[] = [];
  for (const image of images.slice(0, MAX_IMAGE_ATTACHMENTS)) {
    const id = `image-${++bridge.nextAttachmentId}`;
    const name = image.name ?? attachmentName(bridge.nextAttachmentId);
    bridge.pendingImages.set(id, { name, mimeType: image.mimeType, data: image.data, hints: [] });
    restored.push({ id, image: { mimeType: image.mimeType, data: image.data, name } });
  }
  return restored;
}
