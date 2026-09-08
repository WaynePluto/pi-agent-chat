/**
 * 本宿主在 pi 自带工具之外新增的终端工具 `vscode_terminal`。
 *
 * 桶文件：实现拆在 `./vscode-terminal/` 下（按职责一模块），拆分前的
 * 全部导出在此原样再导出，导入方继续用 `./vscode-terminal.js`；
 * 各模块的其余导出均为内部实现。
 */
export { VSCODE_TERMINAL_TOOL } from "./vscode-terminal/constants.js";
export {
  vscodeTerminalApi,
  type DisposableLike,
  type ExecutionLike,
  type ShellIntegrationLike,
  type TerminalApi,
  type TerminalLike,
} from "./vscode-terminal/api.js";
export { VsCodeTerminalPool } from "./vscode-terminal/pool.js";
export type { TerminalToolArgs, TerminalTimeouts, TerminalToolUpdate } from "./vscode-terminal/types.js";
