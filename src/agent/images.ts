import { convertToPng, formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { t, tf } from "./i18n.js";

/**
 * Turn raw bytes from the composer into an `ImageContent` the SDK can attach to
 * a prompt.
 *
 * This is glue over three exported SDK primitives, not a reimplementation:
 * `convertToPng` (photon/WASM), `resizeImage` (photon in a worker thread) and
 * `formatDimensionNote` do all of the actual work. The SDK's own orchestration
 * of them (`utils/image-process.ts`) is not exported; the sequence below is the
 * only part written here, and it is the same sequence any host has to write.
 *
 * Not tagged `SDK-MIRROR:` on purpose: nothing is copied line by line, so there
 * is nothing to diff on an upgrade. The one thing that can drift is
 * {@link PASSTHROUGH_MIME_TYPES} — see the note there.
 */

/**
 * Formats a provider accepts inline, so they are attached as-is.
 *
 * Anything else is converted to PNG first. Keep this list narrow rather than
 * optimistic: sending a format the provider rejects fails the whole request,
 * while an unnecessary conversion only costs bytes.
 *
 * Drift risk: the SDK keeps the same list privately (`normalizeSupportedImage-
 * MimeType`). If it ever gains a format (avif, say), images of that type get
 * re-encoded to PNG here instead of passing through — larger, never wrong.
 * The fix is upstream exporting `processImage()`, not a copy that has to be
 * kept in sync.
 */
const PASSTHROUGH_MIME_TYPES = new Map<string, string>([
  ["image/png", "image/png"],
  ["image/jpeg", "image/jpeg"],
  ["image/jpg", "image/jpeg"],
  ["image/gif", "image/gif"],
  ["image/webp", "image/webp"],
]);

/** Upper bound on what the webview may hand over, before any processing. */
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

export interface PreparedImage {
  /** base64, ready for `ImageContent.data`. */
  data: string;
  mimeType: string;
  /**
   * Host-generated notes about the processing that happened (conversion,
   * downscaling with the coordinate mapping the model needs). They travel in
   * the message text, the way the CLI's `@file` attachments do.
   */
  hints: string[];
}

export type PrepareImageResult = { ok: true; image: PreparedImage } | { ok: false; message: string };

/**
 * Normalize, optionally downscale, and base64-encode one image.
 *
 * `autoResize` comes from the shared `~/.pi/agent/settings.json`
 * (`images.autoResize`), so both hosts treat the same image the same way.
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
    // Unsupported (or mislabelled) input: photon decodes it and re-encodes as
    // PNG. A non-image lands here too and comes back null, which is how a
    // wrong `File.type` from the webview is caught.
    const converted = await convertToPng(data, base || "application/octet-stream");
    if (!converted) return { ok: false, message: t("imageUnsupported") };
    data = converted.data;
    resolvedType = converted.mimeType;
    if (base && base !== resolvedType) hints.push(tf("imageConverted", base, resolvedType));
  }

  if (!autoResize) return { ok: true, image: { data, mimeType: resolvedType, hints } };

  const resized = await resizeImage(Buffer.from(data, "base64"), resolvedType);
  if (!resized) return { ok: false, message: t("imageTooLargeToResize") };
  // The note explains how to map coordinates back to the original; only
  // present when the image was actually scaled.
  const note = formatDimensionNote(resized);
  if (note) hints.push(note);
  return { ok: true, image: { data: resized.data, mimeType: resized.mimeType, hints } };
}

/**
 * The text an attachment contributes to the user message.
 *
 * Shaped after the CLI's `@file` attachments (`<file name="...">hints</file>`),
 * with `<image>` instead of `<file>` because a pasted screenshot is not a file
 * and because it gives the transcript a reliable thing to strip. Always
 * non-empty: the SDK puts a text block first in every user message, and an
 * empty one is rejected by some providers.
 */
export function imageAttachmentMarkup(name: string, hints: readonly string[]): string {
  return `<image name="${name.replace(/["<>]/g, "")}">${hints.join("\n")}</image>`;
}

const IMAGE_MARKUP = /[ \t]*<image name="[^"]*">[\s\S]*?<\/image>[ \t]*\n?/g;

/**
 * Drop attachment markup from text shown to the user.
 *
 * Same idea as `collapseSkillInvocation`: the model reads the expanded form,
 * the transcript shows what the user actually composed — the images themselves
 * are rendered as thumbnails, so repeating their markup is noise.
 */
export function stripImageAttachmentMarkup(text: string): string {
  return text.includes("<image name=") ? text.replace(IMAGE_MARKUP, "").trimEnd() : text;
}

/** Display name for an attachment: the file's own name, or a numbered paste. */
export function attachmentName(index: number, path?: string): string {
  const named = path ? basename(path) : "";
  return named || `clipboard-${index}`;
}
