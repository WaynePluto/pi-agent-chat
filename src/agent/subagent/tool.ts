import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SubagentConfig } from "../config.js";
import { SUBAGENT_TOOL } from "./types.js";

/** 工具调用的一路任务参数；形状与下方 schema 的 TaskItem 对应。 */
export interface SubagentTaskParam {
  task: string;
  scope: string[];
  model?: string;
  title?: string;
}

export type SubagentExecute = (
  tasks: readonly SubagentTaskParam[],
  signal: AbortSignal | undefined,
  onUpdate: ((partial: { content: { type: "text"; text: string }[]; details: unknown }) => void) | undefined,
) => Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;

/** 构建 `subagent` 的工具定义：schema、description 与执行回调的接线。 */
export function defineSubagentTool(config: SubagentConfig, execute: SubagentExecute): ToolDefinition {
  const TaskItem = Type.Object({
    task: Type.String({
      description:
        "Complete, self-contained instruction for this subagent. It starts with a fresh context and cannot ask questions.",
    }),
    scope: Type.Array(Type.String(), {
      description:
        "Paths this subagent may write to, relative to the working directory. Each entry is a directory or a single file, not a glob. Pass an empty array for a subagent that only needs to read or run commands. Writes outside these paths are refused. Ranges of different subagents must not overlap or the call is rejected before anything runs.",
    }),
    model: Type.Optional(Type.String({ description: "Model override as provider/modelId" })),
    title: Type.Optional(Type.String({ description: "Short label for this subagent in the UI" })),
  });

  return defineTool({
    name: SUBAGENT_TOOL,
    label: "Subagent",
    description:
      `Run up to ${config.maxSubagents} isolated subagents at the same time, each on its own task. ` +
      "Every subagent in one call runs concurrently with the others; separate calls run one after another, " +
      "so tasks that could overlap in time belong in the same call. " +
      "Every subagent starts with a fresh context, writes directly to the working tree within the paths it is given, " +
      "and cannot start further subagents. The parent session waits until all of them finish, then receives one report " +
      "listing each subagent's outcome and the files it wrote. Subagents cannot be given follow-up instructions, so each " +
      "task must be complete on its own; their write ranges must not overlap; failed subagents are reported, not undone.",
    promptSnippet: "Run several isolated subagents at once, each writing only within the paths it is given",
    parameters: Type.Object({
      tasks: Type.Array(TaskItem, {
        minItems: 1,
        maxItems: config.maxSubagents,
        description: "Subagents to run concurrently.",
      }),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, onUpdate) => execute(params.tasks, signal, onUpdate),
  }) as ToolDefinition;
}
