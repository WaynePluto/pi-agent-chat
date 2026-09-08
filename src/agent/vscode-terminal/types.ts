import type { ExecutionLike, ShellIntegrationLike, TerminalLike } from "./api.js";

/* —— 池状态 --------------------------------------------------------------- */

/** 终端里跑的一条命令及从它读回的全部内容。 */
export interface CommandRecord {
  command: string;
  startedAt: number;
  endedAt?: number;
  /** 终端产生的每个字节，含转义序列。 */
  raw: string;
  execution?: ExecutionLike;
  running: boolean;
  exitCode?: number;
  exitReported: boolean;
  /** 命令运行期间终端消失了。 */
  terminalClosed: boolean;
  /**
   * 已交给模型的稳定屏幕行数。
   *
   * 按行而非字节计数：重放每次都对整段流做，只放尾巴会丢掉光标指令所参照的
   * 屏幕上下文。
   */
  deliveredLines: number;
}

export interface ManagedTerminal {
  id: string;
  terminal: TerminalLike;
  shellIntegration?: ShellIntegrationLike;
  /** VS Code 填充后的 `TerminalState.shell`。 */
  shell?: string;
  createdAt: number;
  closed: boolean;
  current?: CommandRecord;
  last?: CommandRecord;
}

export interface RunArgs {
  action: "run" | "list" | "read" | "close";
  command?: string;
  terminal?: string;
  timeoutSeconds?: number;
}

/** 模型发来的一次 `vscode_terminal` 调用参数。 */
export type TerminalToolArgs = RunArgs;

/** 命令运行期间推送到工具卡片的实时进展。 */
export interface TerminalToolUpdate {
  text: string;
  details: unknown;
}

/** 等待预算，可覆盖以便自检无需真实 shell。 */
export interface TerminalTimeouts {
  shellIntegrationMs: number;
  shellTypeMs: number;
}
