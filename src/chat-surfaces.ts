/**
 * 单窗口的顶层聊天编排：侧边栏视图与任意多个编辑区 panel 是可互换的 GUI
 * surface，每个独立会话由自己的 controller（`PiRuntime` + `ChatBridge`）驱动；
 * 窗口级会话 claim、surface 间移动、tab 关闭后的无面保活都在这里。
 *
 * Barrel：实现位于 `./chat-surfaces/`，按关注点分模块；拆分前的导出一律
 * 原样重导出，导入方继续用 `./chat-surfaces.js`。
 */
export { ownedSessionFiles, SessionClaimRegistry } from "./chat-surfaces/claims.js";
export { renderChatHtml } from "./chat-surfaces/html.js";
export { ChatSurfaceManager } from "./chat-surfaces/manager.js";
export { claimedSessionSourceStartup, editorPanelTitle, isMovableSessionState, replacementStartupForRunningController, restoredSessionFile, shouldDisposeHeadlessRuntime } from "./chat-surfaces/rules.js";
export { CHAT_PANEL_TYPE, CHAT_VIEW_ID, MAX_EDITOR_TAB_TITLE_CHARS } from "./chat-surfaces/types.js";
