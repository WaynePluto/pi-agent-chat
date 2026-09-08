import type { ProjectFileItem, SlashCommand, TranscriptImage } from "../../shared/protocol.js";

/**
 * composer 的全部可变状态，由原先的模块级变量收拢为一个对象。
 * 字段名沿用原变量名，其他模块经 `cs.<name>` 引用。
 */

/**
 * 粘贴进 composer 的图片，按发送顺序排列。
 *
 * 这里只存 id 与缩略图：宿主持有真正的附件并交回处理后的图片，composer
 * 无须知道一张截图如何变成模型可读的内容。
 */
export interface ImageAttachment {
  id: string;
  image: TranscriptImage;
  note?: string;
}

/** 一条已发送的 prompt：按原样输入的文本加上它的 `@` 引用。 */
export interface InputHistoryEntry {
  text: string;
  references: ProjectFileItem[];
}

export interface ComposerHooks {
  /** prompt 发出前调用（用于离开会话页）。 */
  beforeSend(): void;
}

export interface ComposerState {
  /** `/` 补全状态：完整目录、当前匹配与选中项。 */
  slashCommands: SlashCommand[];
  matches: SlashCommand[];
  selectedIndex: number;
  /** `@` 项目路径选择器状态。 */
  acMode: "slash" | "file";
  fileMatches: ProjectFileItem[];
  fileIncludeIgnored: boolean;
  fileRequestId: number;
  fileQueryTimer: number | undefined;
  /** 选中的引用，以可移除 chip 显示在输入框上方。 */
  fileRefs: ProjectFileItem[];
  imageAttachments: ImageAttachment[];
  /** 宿主仍在处理的附件的占位 chip。 */
  pendingAttachments: number;
  attachmentRequestId: number;
  /** 最近一次拒绝原因，展示到下一次附件尝试成功为止。 */
  attachmentError: string | undefined;
  /**
   * 本窗口已发送的 prompt，新的在后。留在 webview 侧，是因为历史必须存
   * 用户敲的原文，而会话文件存的是展开后的文本（`/skill:` 调用、提示词
   * 模板）。所有会话共享——↑/↓ 是 shell 肌肉记忆，按会话分环会让切换后
   * 按键像坏了一样。仅存内存，与 shell 的历史同生命周期。
   */
  inputHistory: InputHistoryEntry[];
  /** 导航中的位置；undefined 表示正在编辑 live 草稿。 */
  historyIndex: number | undefined;
  /** 导航开始时 composer 的内容，向下走到底时恢复。 */
  draft: InputHistoryEntry;
  hooks: ComposerHooks;
}

export const cs: ComposerState = {
  slashCommands: [],
  matches: [],
  selectedIndex: 0,
  acMode: "slash",
  fileMatches: [],
  fileIncludeIgnored: false,
  fileRequestId: 0,
  fileQueryTimer: undefined,
  fileRefs: [],
  imageAttachments: [],
  pendingAttachments: 0,
  attachmentRequestId: 0,
  attachmentError: undefined,
  inputHistory: [],
  historyIndex: undefined,
  draft: { text: "", references: [] },
  hooks: { beforeSend: () => {} },
};
