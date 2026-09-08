/**
 * **扩展宿主**显示的本地化文案：原生对话框、QuickPick 标题与推入 transcript
 * 的状态提示。
 *
 * 与 webview 字典同处以保持措辞一致；composer 模型选择器也渲染的条目由
 * `webview/i18n.ts` 直接取用。同 `protocol.ts` 必须零依赖——webview bundle
 * 也会导入它。刻意不本地化：`/` 命令目录（逐字对齐 CLI）、spike 诊断命令、
 * SDK 或模型产生的文本。
 */

// 仅 Barrel：字典在 `./messages/`，按职责拆分（固定文案 / models.json 种子 /
// 参数化模板），避免单个文件无限膨胀。全部原样重导出，公开导入路径
// `shared/messages` 不变。
export type { LocalizedText } from "./messages/core.js";
export { isChinese, localize, sharedMessages } from "./messages/core.js";
export { modelsConfigProviderEntry, modelsConfigTemplate } from "./messages/models-config.js";
export { sharedTemplates } from "./messages/templates.js";
