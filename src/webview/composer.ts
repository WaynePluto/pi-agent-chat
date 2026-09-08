/**
 * composer：文本输入、发送 / 插话 / 排队、`/` 命令补全，以及带引用 chip
 * 的 `@` 项目文件选择器。
 *
 * 桶文件：实现拆在 `./composer/` 下（共享状态、编排入口、图片附件、
 * 输入历史、补全面板、chip 条各一模块），拆分前的全部导出在此原样
 * 再导出，导入方继续用 `./composer.js`。
 */
export { clearFileRefs, initComposer, send, setSlashCommands, setInput } from "./composer/composer.js";
export { onAttachment } from "./composer/attachments.js";
export { populateInputHistoryFromEvents } from "./composer/input-history.js";
export { onProjectFiles } from "./composer/autocomplete.js";
