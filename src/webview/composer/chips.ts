import { button, el } from "../dom.js";
import { getDict } from "../i18n.js";
import { fileRefsEl, inputEl } from "../shell.js";
import { post } from "../host.js";
import type { ProjectFileItem } from "../../shared/protocol.js";
import { cs } from "./state.js";

const t = getDict();

/** 目录带尾斜杠展示，与补全面板同一形状。 */
export function displayProjectPath(item: ProjectFileItem): string {
  return item.kind === "directory" ? `${item.path}/` : item.path;
}

/** 输入框上方的 chip 条：`@` 引用、图片附件、待处理占位、错误与说明。 */
export function renderFileRefs(): void {
  fileRefsEl.replaceChildren();
  const empty = cs.fileRefs.length === 0 && cs.imageAttachments.length === 0 && cs.pendingAttachments === 0 && !cs.attachmentError;
  fileRefsEl.classList.toggle("hidden", empty);
  for (const item of cs.fileRefs) {
    const chip = el("span", `file-ref-chip${item.ignored ? " ignored" : ""}${item.sensitive ? " sensitive" : ""}`);
    const displayPath = displayProjectPath(item);
    chip.title = [displayPath, item.ignored ? t.fileIgnoredBadge : "", item.sensitive ? t.fileSensitiveBadge : ""]
      .filter(Boolean)
      .join(" · ");

    const remove = button("file-ref-remove", "×", () => {
      const index = cs.fileRefs.indexOf(item);
      if (index !== -1) cs.fileRefs.splice(index, 1);
      renderFileRefs();
      inputEl.focus();
    });
    remove.title = t.fileRemoveTitle;

    chip.append(el("span", "file-ref-label", `@${displayPath}`), remove);
    fileRefsEl.appendChild(chip);
  }

  for (const attachment of cs.imageAttachments) {
    // chip 显示的是处理后的字节，用户在这里看到的即模型拿到的——包括
    // 已发生的缩放。
    const chip = el("span", `file-ref-chip image${attachment.note ? " warned" : ""}`);
    chip.title = [attachment.image.name, attachment.note].filter(Boolean).join(" · ");
    const thumb = document.createElement("img");
    thumb.className = "file-ref-thumb";
    thumb.src = `data:${attachment.image.mimeType};base64,${attachment.image.data}`;
    thumb.alt = attachment.image.name ?? "";
    const remove = button("file-ref-remove", "×", () => {
      const index = cs.imageAttachments.indexOf(attachment);
      if (index !== -1) cs.imageAttachments.splice(index, 1);
      post({ type: "detachImage", id: attachment.id });
      renderFileRefs();
      inputEl.focus();
    });
    remove.title = t.fileRemoveTitle;
    chip.append(thumb, el("span", "file-ref-label", attachment.image.name ?? t.imageAttachmentLabel), remove);
    fileRefsEl.appendChild(chip);
  }

  for (let i = 0; i < cs.pendingAttachments; i += 1) {
    fileRefsEl.appendChild(el("span", "file-ref-chip image pending", t.imageAttaching));
  }

  // 拒绝必须可见：图片干脆不出现，会被读成粘贴没被理会。
  if (cs.attachmentError) fileRefsEl.appendChild(el("span", "file-ref-error", cs.attachmentError));

  // 整条 chip 区共用一条说明：它描述会话级事实（不支持视觉、设置里禁了
  // 图片），不是单个附件。
  const note = cs.imageAttachments.find((item) => item.note)?.note;
  if (note) fileRefsEl.appendChild(el("span", "file-ref-note", note));
}
