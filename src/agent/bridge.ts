/**
 * `PiRuntime` 与其 webview 之间的双向翻译层：SDK 会话事件 → `HostMessage`，
 * webview 消息 → runtime 操作，会话历史回放走 `agent/history.ts` 的投影。
 *
 * 桶文件：实现拆在 `./bridge/` 下（事件翻译、视图/lane 状态、设置响应、
 * models.json、重试提议、压缩队列、附件、会话列表、UI 动作各一模块），
 * 拆分前的全部导出在此原样再导出，导入方继续用 `./bridge.js`。
 */
export type { BridgeHost } from "./bridge/types.js";
export { ChatBridge } from "./bridge/chat-bridge.js";
