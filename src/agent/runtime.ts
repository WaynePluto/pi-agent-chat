/**
 * SDK `AgentSessionRuntime` 薄封装：会话新建/切换/fork、扩展重绑定、
 * services 的创建与隔离，以及各类扩展事件 sink。
 *
 * 桶文件：实现拆在 `./runtime/` 下（types、会话 services 与隔离、启动
 * 会话解析、扩展 UI 上下文、`PiRuntime` 本体各一模块），拆分前的全部
 * 导出在此原样再导出，导入方继续用 `./runtime.js`。
 */
export type {
  ExtensionNotice,
  ExtensionStatusUpdate,
  ExtensionWidgetUpdate,
  PiRuntimeOptions,
  SessionLifecycleSink,
  StartupSession,
} from "./runtime/types.js";
export { createIsolatedServices, createSubagentServices, findShadowedExtensionTool } from "./runtime/services.js";
export { PiRuntime } from "./runtime/pi-runtime.js";
