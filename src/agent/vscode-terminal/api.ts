import * as vscode from "vscode";

/* —— 宿主表面 ----------------------------------------------------------- */

/**
 * 本模块用到的 VS Code 终端 API 切片。
 *
 * 依赖注入而非直连，`diagnostics.ts` 的自检才能用脚本化实现驱动拒绝路径
 * （无 shell integration、关闭非本工具创建的终端），无需窗口、shell 或真人
 * ——这些正是绝不能退化成「报成功、什么都没做」的路径。
 */
export interface TerminalApi {
  createTerminal(options: { name: string; cwd: string }): TerminalLike;
  onDidChangeTerminalShellIntegration(
    listener: (event: { terminal: TerminalLike; shellIntegration: ShellIntegrationLike }) => void,
  ): DisposableLike;
  onDidEndTerminalShellExecution(
    listener: (event: { terminal: TerminalLike; execution: ExecutionLike; exitCode: number | undefined }) => void,
  ): DisposableLike;
  onDidCloseTerminal(listener: (terminal: TerminalLike) => void): DisposableLike;
  onDidChangeTerminalState(listener: (terminal: TerminalLike) => void): DisposableLike;
}

export interface DisposableLike {
  dispose(): void;
}

export interface TerminalLike {
  readonly name: string;
  readonly shellIntegration?: ShellIntegrationLike | undefined;
  readonly state: { readonly shell?: string | undefined };
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface ShellIntegrationLike {
  executeCommand(commandLine: string): ExecutionLike;
}

export interface ExecutionLike {
  read(): AsyncIterable<string>;
}

/** 真实 API，显式包一层让结构映射保持可见。 */
export function vscodeTerminalApi(): TerminalApi {
  return {
    createTerminal: (options) =>
      vscode.window.createTerminal({
        name: options.name,
        cwd: options.cwd,
        iconPath: new vscode.ThemeIcon("sparkle"),
      }),
    onDidChangeTerminalShellIntegration: (listener) =>
      vscode.window.onDidChangeTerminalShellIntegration((event) =>
        listener({ terminal: event.terminal, shellIntegration: event.shellIntegration }),
      ),
    onDidEndTerminalShellExecution: (listener) =>
      vscode.window.onDidEndTerminalShellExecution((event) =>
        listener({ terminal: event.terminal, execution: event.execution, exitCode: event.exitCode }),
      ),
    onDidCloseTerminal: (listener) => vscode.window.onDidCloseTerminal((terminal) => listener(terminal)),
    onDidChangeTerminalState: (listener) => vscode.window.onDidChangeTerminalState((terminal) => listener(terminal)),
  };
}
