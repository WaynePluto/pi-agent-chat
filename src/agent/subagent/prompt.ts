import type { ScopePrefix } from "../scope.js";

/**
 * 子会话启动时收到的文本。
 *
 * scope 一行陈述本次运行的事实——与告知模型工作目录同类——且有文件层
 * 的拒绝兜底，不是插件编造的行为引导。子代理被告知的其余一切都来自
 * 父代理的 `task`。
 */
export function composePrompt(task: string, scope: readonly ScopePrefix[]): string {
  const parts: string[] = [];
  parts.push(
    `You are one of several subagents running at the same time on this project. The others are working in different parts of it. You cannot see them, contact them, or wait for them, and their changes may appear in files outside your range while you work.`,
  );
  parts.push(
    scope.length > 0
      ? `Files you may write: ${scope.map((prefix) => prefix || "(entire project)").join(", ")}. ` +
          `Writes outside this range are refused. You can read anything.`
      : `You cannot write files: every write is refused. You can read anything and run commands.`,
  );
  parts.push(`Task: ${task}`);
  return parts.join("\n\n");
}

/** 任务的单行短形式，用于标题与错误消息。 */
export function summarize(task: string): string {
  const first = task.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return first.length > 60 ? `${first.slice(0, 57)}...` : first || "task";
}
