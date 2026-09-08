import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";
import { BOOLEAN_EXIT_SHELLS } from "./constants.js";
import type { CommandRecord } from "./types.js";

/* —— 文本辅助 --------------------------------------------------------------- */

export const OUTPUT_BANNER =
  "--- terminal output (the screen as it appears, including the shell prompt, the echoed command line and " +
  "anything the user typed into the terminal) ---";

/**
 * 按 shell integration 实际能报告的口径描述退出状态。
 *
 * VS Code 的 `shellIntegration.ps1` 在 OSC 633 `D` 里发的是 `[int]!$?`（源码
 * 里就叫 `$FakeCode`），PowerShell 下只有成功/失败可用；bash 脚本发的才是真
 * `$?`。把编造的 `1` 当退出码交给模型是造假，而退出码有模型会推理的语义
 * （`grep` 1=无匹配、2=出错）。两种 shell 措辞不同是刻意的诚实。
 */
export function describeExit(record: CommandRecord, shell: string | undefined): string {
  if (record.terminalClosed) return "The terminal was closed before the command finished, so it has no exit status.";
  if (record.running) return "Still running.";
  if (!record.exitReported || record.exitCode === undefined) {
    return "The shell reported no exit status for it (it may have been interrupted).";
  }
  const ok = record.exitCode === 0;
  if (shell && BOOLEAN_EXIT_SHELLS.has(shell)) {
    return ok
      ? "The command succeeded. (PowerShell's shell integration reports only success or failure, never the exit code itself.)"
      : "The command FAILED. (PowerShell's shell integration reports only success or failure, so the real exit code is not available here.)";
  }
  if (!shell) {
    return ok
      ? "The command succeeded (exit code 0)."
      : `The command FAILED (the shell reported exit code ${record.exitCode}; some shells, PowerShell among them, report only success or failure).`;
  }
  return ok ? "The command succeeded (exit code 0)." : `The command FAILED with exit code ${record.exitCode}.`;
}

/**
 * 把 transcript 控制在与 pi 自带 `bash` 工具相同的预算内。
 *
 * 终端 transcript 比纯 stdout 只大不小（提示符、命令回显、进度条重绘），纪律
 * 在这里更要紧。与 `bash` 一致保留尾部：命令的结果就在末尾。
 */
export function truncate(lines: string[]): { text: string; truncated: boolean; notes: string[] } {
  const joined = lines.join("\n");
  const result = truncateTail(joined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!result.truncated) return { text: result.content, truncated: false, notes: [] };
  return {
    text: result.content,
    truncated: true,
    notes: [
      `--- only the last ${result.outputLines} of ${result.totalLines} line(s) are shown; ` +
        `the earlier output is not available through this tool ---`,
    ],
  };
}
