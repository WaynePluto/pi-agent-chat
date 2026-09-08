import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * 把用户消息归因到产出它的 `/` 命令，供资源面板点亮背后的提示词模板
 * 或扩展——`skills.ts` 归因工作的非技能半边。SDK 不发「用了提示词
 * 模板」「跑了扩展命令」事件，且两者落盘前就被改写：`session.prompt()`
 * 把 `/<模板> 参数` 替换成展开正文（`core/prompt-templates.ts`），不留
 * 标记；扩展命令被直接消费，不进会话文件。
 *
 * 实时提交还带着用户敲的原文，归属就在那里解析；回放时只有不含 `$`
 * 占位符的模板能找回（存的就是逐字正文），其余不归因（显示「未见过使用」）。
 */

/** 一条提示词模板；body 仅在回放能精确匹配时保留。 */
interface PromptEntry {
  name: string;
  /** 裁剪后的模板正文；含 `$` 占位符导致不稳定时为 undefined。 */
  body?: string;
}

export type PromptIndex = readonly PromptEntry[];

export const EMPTY_PROMPT_INDEX: PromptIndex = [];

/** 给已加载的提示词模板拍快照；会话替换或 `/reload` 后重建。 */
export function buildPromptIndex(session: AgentSession): PromptIndex {
  try {
    return session.promptTemplates.map((template) => ({
      name: template.name,
      // `$1`、`$ARGUMENTS`、`${@:2}` 等在展开时被替换，只有不含
      // 占位符的正文才能当精确匹配的键存活下来。
      ...(template.content.includes("$") ? {} : { body: template.content.trim() }),
    }));
  } catch {
    return EMPTY_PROMPT_INDEX;
  }
}

/** 一次 `/` 命令提交实际调用了什么，在会话改写它之前解析。 */
export interface CommandInvocation {
  /** 提示词模板名，不含前导斜杠。 */
  prompt?: string;
  /** 提供该命令的扩展的绝对路径。 */
  extension?: string;
  /**
   * 为真表示这是一条扩展命令。它立即执行、不发 prompt，
   * 调用方不得把它当排队/steering 提交处理。
   */
  isExtensionCommand: boolean;
}

/**
 * 用会话自己的目录解析一次实时提交。
 *
 * 扩展命令优先于提示词模板，与 `AgentSession.prompt()` 的顺序一致
 * （命令先分发、模板后展开）。
 */
export function resolveInvocation(session: AgentSession, text: string): CommandInvocation {
  if (!text.startsWith("/")) return { isExtensionCommand: false };
  const separator = text.indexOf(" ");
  const name = separator === -1 ? text.slice(1) : text.slice(1, separator);
  if (!name) return { isExtensionCommand: false };

  try {
    const command = session.extensionRunner.getRegisteredCommands().find((entry) => entry.invocationName === name);
    if (command) {
      const path = command.sourceInfo?.path;
      return { isExtensionCommand: true, ...(path ? { extension: path } : {}) };
    }
  } catch {
    // 落到下面：runner 不可用只是意味着不归因。
  }

  try {
    if (session.promptTemplates.some((template) => template.name === name)) return { prompt: name, isExtensionCommand: false };
  } catch {
    // 同上：归因是尽力而为。
  }
  return { isExtensionCommand: false };
}

/**
 * 为已存盘的用户消息找回其模板，仅限逐字保留的无占位符正文；
 * 其余一律返回 undefined。
 */
export function expandedPrompt(index: PromptIndex, text: string): string | undefined {
  if (index.length === 0) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return index.find((entry) => entry.body === trimmed)?.name;
}
