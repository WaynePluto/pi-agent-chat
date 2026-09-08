import type { SlashCommand } from "../../shared/protocol.js";
import { inputEl, resizeHandleEl } from "../shell.js";
import { state } from "../store.js";
import { post } from "../host.js";
import { followLatest } from "../transcript.js";
import { onPaste } from "./attachments.js";
import {
  acceptCompletion,
  closeAutocomplete,
  currentFilePrefix,
  isAutocompleteOpen,
  moveSelection,
  requestFileMatches,
  updateAutocomplete,
} from "./autocomplete.js";
import { navigateInputHistory, pushInputHistory } from "./input-history.js";
import { renderFileRefs } from "./chips.js";
import { cs, type ComposerHooks } from "./state.js";

/**
 * composer 的编排入口：事件接线、发送、以及键盘路由。
 *
 * composer 需要的外部能力都经 `initComposer()` 传入，本目录绝不回头碰
 * 页面布局。
 */

const AUTOCOMPLETE_BLUR_DELAY_MS = 120;
const MIN_INPUT_HEIGHT_PX = 48;
/** 该拖拽上限须与 textarea 的 CSS max-height 保持一致。 */
const MAX_INPUT_HEIGHT_PX = 320;
const MAX_INPUT_HEIGHT_RATIO = 0.3;

export function initComposer(composerHooks: ComposerHooks): void {
  cs.hooks = composerHooks;

  inputEl.addEventListener("keydown", onKeyDown);
  inputEl.addEventListener("input", () => updateAutocomplete());
  inputEl.addEventListener("blur", () => window.setTimeout(closeAutocomplete, AUTOCOMPLETE_BLUR_DELAY_MS));
  inputEl.addEventListener("paste", onPaste);

  /* composer 调高：拖动上边缘，而不是角落手柄。 */
  resizeHandleEl.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    resizeHandleEl.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = inputEl.offsetHeight;
    const onMove = (move: PointerEvent) => {
      const height = Math.min(
        Math.max(startHeight + (startY - move.clientY), MIN_INPUT_HEIGHT_PX),
        Math.min(window.innerHeight * MAX_INPUT_HEIGHT_RATIO, MAX_INPUT_HEIGHT_PX),
      );
      inputEl.style.height = `${height}px`;
    };
    const onUp = () => {
      resizeHandleEl.removeEventListener("pointermove", onMove);
      resizeHandleEl.removeEventListener("pointerup", onUp);
    };
    resizeHandleEl.addEventListener("pointermove", onMove);
    resizeHandleEl.addEventListener("pointerup", onUp);
  });
}

export function setSlashCommands(items: SlashCommand[]): void {
  cs.slashCommands = items;
}

export function send(streamingBehavior?: "steer" | "followUp"): void {
  if (state.inputDisabled) return;
  const text = inputEl.value.trim();
  const references = cs.fileRefs.map((item) => item.path);
  const imageIds = cs.imageAttachments.map((item) => item.id);
  if (!text && references.length === 0 && imageIds.length === 0) return;
  // 图片有意不进 ↑/↓ 输入历史：历史条目是「再要说一遍」的文本，附件则
  // 随它所在的消息一次性消费掉。
  pushInputHistory({ text, references: cs.fileRefs.map((item) => ({ ...item })) });
  inputEl.value = "";
  cs.fileRefs.length = 0;
  cs.imageAttachments.length = 0;
  renderFileRefs();
  closeAutocomplete();
  cs.hooks.beforeSend();
  followLatest();
  post({
    type: "prompt",
    text,
    references: references.length ? references : undefined,
    imageIds: imageIds.length ? imageIds : undefined,
    streamingBehavior,
  });
}

/** 替换 composer 内容，例如从某条用户消息分叉之后。 */
export function setInput(text: string): void {
  // 程序化替换会终结任何历史导航：屏幕上现在是什么，新的 live 草稿就是什么。
  cs.historyIndex = undefined;
  cs.draft = { text: "", references: [] };
  inputEl.value = text;
  closeAutocomplete();
  inputEl.focus();
  inputEl.setSelectionRange(text.length, text.length);
}

export function clearFileRefs(): void {
  cs.fileRefs.length = 0;
  cs.imageAttachments.length = 0;
  cs.attachmentError = undefined;
  renderFileRefs();
}

function onKeyDown(event: KeyboardEvent): void {
  // 只要光标在 @token 上就允许切换 gitignore 文件，即便面板因当前过滤
  // 无匹配而自行关过。
  if (event.key === "ArrowRight" && event.ctrlKey && currentFilePrefix() !== undefined) {
    event.preventDefault();
    cs.fileIncludeIgnored = !cs.fileIncludeIgnored;
    requestFileMatches();
    return;
  }
  if (isAutocompleteOpen()) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      acceptCompletion();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeAutocomplete();
      return;
    }
  }
  // Shell 风格的输入历史。方向键只在文本的外层行被劫持：第一行上方、
  // 最后一行下方都没有别的行，单行 composer 因此与 readline 肌肉记忆完
  // 全一致——每按一次 ↑ 回退一条、↓ 前进一条；多行草稿中间的方向键留给
  // 光标移动，编辑不被劫持。IME 组合中不劫持：方向键归候选窗。
  if (
    (event.key === "ArrowUp" || event.key === "ArrowDown") &&
    !event.isComposing &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    const caret = inputEl.selectionStart;
    if (caret !== null && caret === inputEl.selectionEnd) {
      const onFirstLine = !inputEl.value.slice(0, caret).includes("\n");
      const onLastLine = !inputEl.value.slice(caret).includes("\n");
      if (event.key === "ArrowUp" && onFirstLine) {
        event.preventDefault();
        navigateInputHistory(-1);
      } else if (event.key === "ArrowDown" && onLastLine) {
        event.preventDefault();
        navigateInputHistory(1);
      }
    }
  }
  if (event.key === "Enter") {
    // Ctrl+Enter 插入换行（Shift+Enter 原生支持）；只有纯 Enter 发送。
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const { selectionStart, selectionEnd, value } = inputEl;
      inputEl.value = `${value.slice(0, selectionStart)}\n${value.slice(selectionEnd)}`;
      inputEl.selectionStart = inputEl.selectionEnd = selectionStart + 1;
      return;
    }
    if (!event.shiftKey) {
      event.preventDefault();
      send(state.isStreaming || state.isCompacting ? "followUp" : undefined);
    }
  }
}
