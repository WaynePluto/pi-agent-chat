import type { LaneState } from "./types.js";

/**
 * 交给父代理的汇报。
 *
 * 写成能自解释的：会话若在 CLI 里 resume（那里没有这个工具），仅凭
 * 文本也要能读懂发生了什么。半成品要显式点名，因为读到一个
 * "failed" 很容易默认什么都没发生——在这里通常不是。
 */
export function report(lanes: readonly LaneState[]): string {
  const completed = lanes.filter((lane) => lane.status === "completed").length;
  const lines: string[] = [
    `Subagents: ${completed}/${lanes.length} completed. All changes were written to the working tree and none were rolled back.`,
    "",
  ];

  for (const lane of lanes) {
    const mark = lane.status === "completed" ? "[ok]" : "[--]";
    const ranges = lane.scope.map((prefix) => prefix || ".").join(", ");
    lines.push(`${mark} ${lane.title}  scope: ${ranges}`);
    lines.push(`     ${statusLine(lane)}`);
    if (lane.summary) lines.push(...indent(lane.summary));
    if (lane.writtenFiles.length > 0) {
      const label = lane.status === "completed" ? "wrote" : "wrote before stopping";
      lines.push(`     ${label}: ${lane.writtenFiles.join(", ")}`);
    } else if (lane.status !== "completed") {
      lines.push("     wrote before stopping: (nothing)");
    }
    if (lane.scopeViolations > 0) {
      lines.push(
        `     refused ${lane.scopeViolations} write(s) outside its range — this task needed files it was not given.`,
      );
      if (lane.deniedPaths.length > 0) {
        lines.push(`     still unchanged, outside its range: ${lane.deniedPaths.join(", ")}`);
      }
    }
    if (lane.bashMayHaveWritten) {
      lines.push("     ran shell commands; any files those wrote are not listed above.");
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function statusLine(lane: LaneState): string {
  switch (lane.status) {
    case "completed":
      return "completed";
    case "stopped":
      return lane.failure === "stopped_by_user"
        ? "STOPPED BY THE USER — do not restart it unless asked"
        : "STOPPED with the rest of the run";
    case "failed":
      return "FAILED";
    default:
      return "still running";
  }
}

function indent(text: string): string[] {
  return text
    .split(/\r?\n/)
    .slice(0, 40)
    .map((line) => `     ${line}`);
}
