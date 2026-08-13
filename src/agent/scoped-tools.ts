import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ScopeGuard } from "./scope.js";

/**
 * `edit` and `write` for a subagent, restricted to its declared write ranges.
 *
 * These are pi's own tool definitions — same name, same schema, same behaviour —
 * built through the SDK's public factories with a replacement file-operation
 * layer. Nothing about the tools is reimplemented here; the only additions are
 * a range check and a record of what was written.
 *
 * This is the single enforcement point, and it exists because
 * `CreateAgentSessionFromServicesOptions` has no `toolsOptions`: the built-in
 * tools cannot be reconfigured, so a child session excludes them by name and
 * receives these instead.
 *
 * Reads are deliberately unrestricted. A subagent has to understand code it is
 * not allowed to change, so the range governs mutation only.
 *
 * Known gap: `bash` can still write anywhere. Whether a shell command writes,
 * and where, is not decidable without running it, so neither the check nor the
 * bookkeeping can cover it. Results say so explicitly rather than implying the
 * file list is complete.
 */
export function createScopedFileTools(cwd: string, guard: ScopeGuard): ToolDefinition[] {
  const editTool = createEditToolDefinition(cwd, {
    operations: {
      readFile: (path) => readFile(path),
      access: async (path) => {
        // `edit` only calls this on files it is about to modify, so refusing
        // here surfaces the range violation before any diff work happens.
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

/** Names the child session must drop so the scoped versions above take over. */
export const SCOPED_TOOL_NAMES = ["edit", "write"] as const;
