import { MAX_IMAGE_ATTACHMENTS, type TranscriptImage } from "../../shared/protocol.js";
import { t } from "../i18n.js";
import {
  attachmentName,
  prepareImage,
  MAX_ATTACHMENT_BYTES,
} from "../images.js";
import type { ChatBridge } from "./chat-bridge.js";

type PendingImage = { name: string; mimeType: string; data: string; hints: string[] };

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

  const prepared = await prepareImage(bytes, request.mimeType ?? "", bridge.runtime.settingsManager.getImageAutoResize());
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

/** 按 composer 展示的顺序，消费一次 prompt 声明的附件。 */
export function takeAttachments(bridge: ChatBridge, ids?: string[]): PendingImage[] {
  if (!ids?.length) return [];
  const taken: PendingImage[] = [];
  for (const id of ids.slice(0, MAX_IMAGE_ATTACHMENTS)) {
    const image = bridge.pendingImages.get(id);
    if (!image) continue;
    bridge.pendingImages.delete(id);
    taken.push(image);
  }
  return taken;
}
