import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TerminalConfig } from "../config.js";
import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, VSCODE_TERMINAL_TOOL } from "./constants.js";
import type { RunArgs, TerminalToolUpdate } from "./types.js";

/**
 * 告诉模型的工具说明。
 *
 * 只陈述机制（做什么、代价、哪些渲染不保真），不写策略。何时优先用它、与其
 * 他跑命令工具的关系、项目允不允许用，归用户写进 `~/.pi/agent/APPEND_SYSTEM.md`
 * 或项目 `AGENTS.md`，CLI 与本宿主共享同一份。
 */
const TOOL_DESCRIPTION = `Run a command in a VS Code integrated terminal that stays visible to the user.
The user can watch the command and type into it while it runs; anything they
type is included in the returned transcript.

The terminal persists across calls, so shell state — working directory,
environment variables, shell variables — carries over from one command to the
next. Creating a terminal costs about 4 seconds before its first command can
run; reusing an existing one costs about 15ms.

Output is rendered by replaying the terminal's cursor movements, so line
editing and progress bars read as they appear on screen; full-screen programs
are not rendered faithfully.

A command that has not finished within its timeout is left running, and the
output so far is returned; use "read" for what happened since, or "close" to
end it. Only terminals this tool created can be listed, read or closed.

Requires VS Code shell integration. Where it is not available the command is
not run and an error is returned instead. Exit codes are exact on POSIX
shells; on PowerShell only success or failure is available.`;

/** 池的公开 `execute`，工具定义委托给它。 */
export interface TerminalToolExecutor {
  execute(
    args: RunArgs,
    config: TerminalConfig,
    signal?: AbortSignal,
    onUpdate?: (update: TerminalToolUpdate) => void,
  ): Promise<{ text: string; details: unknown }>;
}

export function createTerminalTool(executor: TerminalToolExecutor, config: TerminalConfig): ToolDefinition {
  const parameters = Type.Object({
    action: Type.Union(
      [Type.Literal("run"), Type.Literal("list"), Type.Literal("read"), Type.Literal("close")],
      {
        description:
          "run: execute a command. list: show the terminals this tool has open. " +
          "read: return output produced since the last read, for a command that had not finished. " +
          "close: dispose one of this tool's terminals, ending whatever is running in it.",
      },
    ),
    command: Type.Optional(Type.String({ description: "The command line to run. Required for `run`." })),
    terminal: Type.Optional(
      Type.String({
        description:
          "Id of a terminal from `list`. For `run`, reuse that terminal instead of any free one; " +
          "required for `read` and `close`.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: MAX_TIMEOUT_SECONDS,
        description:
          `How long to wait for the command before returning (default ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_TIMEOUT_SECONDS}). ` +
          "On timeout the command is left running and the output so far is returned.",
      }),
    ),
  });

  return defineTool({
    name: VSCODE_TERMINAL_TOOL,
    label: "VS Code terminal",
    description: TOOL_DESCRIPTION,
    promptSnippet: "Run a command in a VS Code terminal that stays visible to the user and accepts their typing",
    parameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const result = await executor.execute(params as RunArgs, config, signal, (update) =>
        onUpdate?.({ content: [{ type: "text", text: update.text }], details: update.details }),
      );
      return { content: [{ type: "text" as const, text: result.text }], details: result.details };
    },
  }) as ToolDefinition;
}
