/**
 * 扩展宿主与聊天 webview 之间的消息协议。
 *
 * 双方都导入这些类型；文件必须零依赖，webview bundle 才不会引入 Node 代码。
 *
 * 桶文件：实现拆在 `./protocol/` 下（布局几何常量、数据形状与共用常量、
 * 两向消息联合各一模块），拆分前的全部导出在此原样再导出，导入方继续用
 * `./protocol.js`。
 */
export {
  CENTER_MIN_WIDTH,
  CHAT_COLUMN_GUTTER_WIDTH,
  CONTENT_WIDTH_MIN,
  DEFAULT_CONTENT_MAX_WIDTH,
  DEFAULT_WIDE_THRESHOLD,
  RAIL_DEFAULT_WIDTH,
  RAIL_MAX_WIDTH,
  RAIL_MIN_WIDTH,
  WIDE_GRID_CHROME_WIDTH,
  WIDE_THRESHOLD_MIN,
} from "./protocol/layout.js";
export type { ThinkingLevelName, JsonValue } from "./protocol/types.js";
export {
  DEFAULT_FOLD_LINES,
  MAX_FILE_REFERENCES,
  MAX_IMAGE_ATTACHMENTS,
  SUBAGENT_TOOL,
  VSCODE_TERMINAL_TOOL,
} from "./protocol/types.js";
export type {
  ChatState,
  ChatStats,
  DelegationLane,
  DelegationState,
  ExtensionStatusItem,
  ExtensionWidget,
  ModelCatalog,
  ModelOption,
  ProjectFileItem,
  ResourceItem,
  ResourceScope,
  ResourceSection,
  SessionListItem,
  SkillRef,
  SlashCommand,
  SubagentSetup,
  ToolSetup,
  TranscriptImage,
} from "./protocol/types.js";
export type { ChatEvent, HostMessage, RetryOfferState, WebviewMessage } from "./protocol/messages.js";
