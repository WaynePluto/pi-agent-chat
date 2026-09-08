import { convertToPng, formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { t, tf } from "./i18n.js";

/**
 * 把 composer 送来的原始字节变成 SDK 能附到 prompt 上的 `ImageContent`。
 * 这是对三个已导出 SDK 原语的粘合，不是复刻：`convertToPng`
 * （photon/WASM）、`resizeImage`（worker 线程里的 photon）与
 * `formatDimensionNote` 干全部实活。SDK 自己的编排
 * （`utils/image-process.ts`）未导出；下面这段序列是这里唯一手写的部分。
 *
 * 故意不打 `SDK-MIRROR:` 标记：没有逐行拷贝，升级时无需比对。唯一会
 * 漂移的是 {@link PASSTHROUGH_MIME_TYPES}——见其说明。
 */

/**
 * 供应商接受的行内格式，原样附上；其余一律先转 PNG。宁可窄也不要
 * 乐观：发送供应商拒绝的格式会失败整次请求，而多余的转换只多几个字节。
 *
 * 漂移风险：SDK 私下维护同一份清单（`normalizeSupportedImageMimeType`）。
 * 它将来新增格式（比如 avif）时，该类型的图在这里会被重编码成 PNG——
 * 更大，但绝不会错。正确修法是上游导出 `processImage()`，不是维护一份
 * 要人肉同步的拷贝。
 */
const PASSTHROUGH_MIME_TYPES = new Map<string, string>([
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/gif", "image/gif"],
  ["image/webp", "image/webp"],
]);

/** webview 单次可递交的上限，在任何处理之前。 */
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

export interface PreparedImage {
  /** base64，可直接用于 `ImageContent.data`。 */
  data: string;
  mimeType: string;
  /**
   * 宿主生成的处理说明（转换、按共享设置缩小及模型所需的坐标换算）。
   * 随消息正文走，形状对齐 CLI 的 `@file` 附件。
   */
  hints: string[];
}

export type PrepareImageResult = { ok: true; image: PreparedImage } | { ok: false; message: string };

/**
 * 规范化、按需缩小并 base64 编码一张图。
 *
 * `autoResize` 来自共享的 `~/.pi/agent/settings.json`
 * （`images.autoResize`），两个宿主对同一张图的处理因此一致。
 */
export async function prepareImage(bytes: Uint8Array, mimeType: string, autoResize: boolean): Promise<PrepareImageResult> {
  if (bytes.byteLength === 0) return { ok: false, message: t("imageEmpty") };
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return { ok: false, message: t("imageTooLarge") };

  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  const passthrough = PASSTHROUGH_MIME_TYPES.get(base);
  const hints: string[] = [];

  let data = Buffer.from(bytes).toString("base64");
  let resolvedType = passthrough ?? "image/png";
  if (!passthrough) {
    // 不支持（或标错类型）的输入：photon 解码后重编码为 PNG。
    // 非图片也走到这里并返回 null，webview 传错的 `File.type`
    // 由此被识破。
    const converted = await convertToPng(data, base || "application/octet-stream");
    if (!converted) return { ok: false, message: t("imageUnsupported") };
    data = converted.data;
    resolvedType = converted.mimeType;
    if (base && base !== resolvedType) hints.push(tf("imageConverted", base, resolvedType));
  }

  if (!autoResize) return { ok: true, image: { data, mimeType: resolvedType, hints } };

  const resized = await resizeImage(Buffer.from(data, "base64"), resolvedType);
  if (!resized) return { ok: false, message: t("imageTooLargeToResize") };
  // 说明如何把坐标换算回原图；只在图确实被缩放时出现。
  const note = formatDimensionNote(resized);
  if (note) hints.push(note);
  return { ok: true, image: { data: resized.data, mimeType: resized.mimeType, hints } };
}

/**
 * 附件写进用户消息的文本。
 *
 * 形状对齐 CLI 的 `@file` 附件（`<file name="...">hints</file>`），用
 * `<image>` 而非 `<file>`：粘贴的截图不是文件，且这让 transcript 有了
 * 可靠的剥离目标。永不为空：SDK 把文本块放在每条用户消息最前，某些
 * 供应商会拒绝空文本块。
 */
export function imageAttachmentMarkup(name: string, hints: readonly string[]): string {
  return `<image name="${name.replace(/["<>]/g, "")}">${hints.join("\n")}</image>`;
}

const IMAGE_MARKUP = /[ \t]*<image name="[^"]*">[\s\S]*?<\/image>[ \t]*\n?/g;

/**
 * 从面向用户展示的文本中剥掉附件标记。
 *
 * 与 `collapseSkillInvocation` 同一思路：模型读展开形式，transcript 展示
 * 用户实际编写的内容——图片本身渲染成缩略图，重复其标记只是噪声。
 */
export function stripImageAttachmentMarkup(text: string): string {
  return text.includes("<image name=") ? text.replace(IMAGE_MARKUP, "").trimEnd() : text;
}

/** 附件的显示名：文件自身名，或按序编号的粘贴。 */
export function attachmentName(index: number, path?: string): string {
  const named = path ? basename(path) : "";
  return named || `clipboard-${index}`;
}
