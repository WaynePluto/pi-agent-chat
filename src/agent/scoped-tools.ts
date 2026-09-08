import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ScopeGuard } from "./scope.js";

/**
 * 供子代理使用的 `edit`/`write`，限制在其声明的可写范围内。这就是
 * pi 自己的工具定义——同名、同 schema、同行为——只是经 SDK 公开工厂
 * 重建并替换文件操作层；新增的只有范围检查与写入记账。
 *
 * 唯一强制点：`CreateAgentSessionFromServicesOptions` 没有
 * `toolsOptions`，内置工具无法重配，故子会话按名排除内置版、改收这里的
 * 同名版本。读刻意不受限（范围只管写）。已知缺口：`bash` 仍可写任何
 * 位置——shell 命令写不写、写哪里不跑就不可判定，结果文本会明说。
 */
export function createScopedFileTools(cwd: string, guard: ScopeGuard): ToolDefinition[] {
  const editTool = createEditToolDefinition(cwd, {
    operations: {
      readFile: (path) => readFile(path),
      access: async (path) => {
        // `edit` 只在即将修改某文件时才调它，在这里拒绝可让越界
        // 在进入 diff 流程之前就暴露。
        guard.assertWritable(path);
        await access(path, constants.R_OK | constants.W_OK);
      },
      writeFile: async (path, content) => {
        guard.recordWrite(path);
        await writeFile(path, content, "utf8");
      },
    },
  });

  const writeTool = createWriteToolDefinition(cwd, {
    operations: {
      writeFile: async (path, content) => {
        guard.recordWrite(path);
        await writeFile(path, content, "utf8");
      },
      mkdir: async (dir) => {
        guard.assertWritable(dir);
        await mkdir(dir, { recursive: true });
      },
    },
  });

  return [editTool as ToolDefinition, writeTool as ToolDefinition];
}

/** 子会话必须排除这两个内置名，上面的受限版本才能接管。 */
export const SCOPED_TOOL_NAMES = ["edit", "write"] as const;
