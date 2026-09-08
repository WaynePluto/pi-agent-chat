import { MAX_IMAGE_ATTACHMENTS, type TranscriptImage } from "../../shared/protocol.js";
import { post } from "../host.js";
import { state } from "../store.js";
import { renderFileRefs } from "./chips.js";
import { cs } from "./state.js";

/**
 * 粘贴是图片进来的唯一入口。
 *
 * 不提供拖放，也没法提供：窗口内一有拖拽，VS Code workbench 就给所有
 * webview iframe 设 `pointer-events: none`（`_startBlockingIframeDragEvents`），
 * webview 根本收不到 `dragover`/`drop`。截图与文件管理器里复制的文件都
 * 走剪贴板，这条路是通的。
 *
 * 仅当剪贴板确实带图片时接管；普通文本粘贴保持默认行为。
 */
export function onPaste(event: ClipboardEvent): void {
  if (state.inputDisabled) return;
  const files = imageFilesOf(event.clipboardData);
  if (files.length === 0) return;
  event.preventDefault();
  for (const file of files) void attachFile(file);
}

function imageFilesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files ?? []).filter((file) => file.type.startsWith("image/"));
}

async function attachFile(file: File): Promise<void> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  // btoa() 只吃二进制字符串；分块拼接，避免大截图撑爆 String.fromCharCode
  // 的参数上限。
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  requestAttachment({ name: file.name, mimeType: file.type, data: btoa(binary) });
}

function requestAttachment(request: { name?: string; mimeType?: string; data?: string }): void {
  if (cs.imageAttachments.length + cs.pendingAttachments >= MAX_IMAGE_ATTACHMENTS) return;
  cs.pendingAttachments += 1;
  renderFileRefs();
  post({ type: "attachImage", requestId: ++cs.attachmentRequestId, ...request });
}

/** 宿主对一次 `attachImage` 的应答：处理后的图片，或拒绝原因。 */
export function onAttachment(id: string | undefined, image?: TranscriptImage, note?: string, error?: string): void {
  cs.pendingAttachments = Math.max(0, cs.pendingAttachments - 1);
  if (error !== undefined || !id || !image) {
    cs.attachmentError = error;
    renderFileRefs();
    return;
  }
  cs.attachmentError = undefined;
  cs.imageAttachments.push({ id, image, note });
  renderFileRefs();
}
