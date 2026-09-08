import type { AgentSessionServices, WidgetPlacement } from "@earendil-works/pi-coding-agent";
import type { SubagentConfig, TerminalConfig } from "../config.js";

/**
 * 新 runtime 打开哪个会话。
 *
 * `file` 是聊天 surface 正常启动时的请求：记住上次显示的会话，而不是磁盘上
 * 最新的那个（用户可能切回了旧会话，CLI 也可能在同一 cwd 写入了更新的）。
 * `recent` 是窗口没有记忆时的兜底，对应 `pi --continue`。
 */
export type StartupSession =
  | { mode: "new" }
  | { mode: "recent" }
  | { mode: "file"; path: string };

export interface PiRuntimeOptions {
  cwd: string;
  /** 默认新建会话，同不带参数的 `pi`。 */
  startup?: StartupSession;
  log: (message: string) => void;
  /**
   * 本窗口另一顶层 runtime 的 services。
   *
   * 只共享 model/auth 与 settings 存储；新 runtime 仍持有私有 ResourceLoader
   * 与扩展 runtime——两个活会话共享它们会把所有扩展的 `pi.*` 动作重定向，
   * 且任一会话 dispose 都会毒死另一个。
   */
  sharedServices?: AgentSessionServices;
  /**
   * 当别的 surface 已持有 `sessionFile` 且已通过揭示该 surface 处理请求时
   * 返回 true。宿主与扩展发起的会话切换在 SDK 替换之前都会先检查这里。
   */
  redirectClaimedSession?: (sessionFile: string) => boolean | Promise<boolean>;
}

/**
 * 当前会话委派工具的装配情况，由会话工厂在每次（重）建时写入。
 *
 * 两个值只服务于新会话提示：它们描述屏幕上这个会话怎么装配的，必须来自
 * 产出该会话的那次构建，而不是此后可能已变的设置值。
 */
export interface ToolSetupRef {
  /** 被屏蔽 `subagent` 工具的扩展（若有）。 */
  shadowedSubagent?: string;
  /** 被屏蔽 `vscode_terminal` 工具的扩展（若有）。 */
  shadowedTerminal?: string;
  /** 本会话工具集实际构建所用的配置。 */
  subagent: SubagentConfig;
  /** 终端工具同理。 */
  terminal: TerminalConfig;
}

// pi 扩展的 `ctx.ui.notify` 调用，路由到 transcript。
export interface ExtensionNotice {
  level: "info" | "warning" | "error";
  text: string;
}

/**
 * pi 扩展的 `ctx.ui.setStatus` / `ctx.ui.setWidget` 调用。
 *
 * 两者都是 SDK `ExtensionUIContext` 中宿主无关的成员（CLI 渲染在其 footer
 * 与编辑器附近），所以同 `notify` 一样欠它一个渲染。扩展清除条目时
 * `text` / `lines` 为 `undefined`。
 */
export interface ExtensionStatusUpdate {
  key: string;
  text: string | undefined;
}

export interface ExtensionWidgetUpdate {
  key: string;
  lines: string[] | undefined;
  placement: WidgetPlacement;
}

/**
 * 扩展命令上下文（命令 handler 里的 `ctx.*`）的宿主侧。
 *
 * `ctx.newSession()` / `ctx.fork()` / `ctx.switchSession()` /
 * `ctx.navigateTree()` / `ctx.reload()` 都会改变所属 surface 的显示内容，
 * SDK 替不了这一半（CLI 在 `modes/rpc/rpc-mode.ts` 接同样的事）。
 */
export interface SessionLifecycleSink {
  /** 重建视图：当前会话（或其另一分支）变了。 */
  reattach(): Promise<void>;
  /** 重载资源，并带上 sidebar 的簿记。 */
  reload(): Promise<void>;
}
