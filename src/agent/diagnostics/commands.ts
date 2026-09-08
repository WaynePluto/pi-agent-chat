/** 斜杠命令目录、会话树与项目文件索引的自检。 */
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { collectSlashCommands } from "../commands.js";
import { describe } from "../errors.js";
import { ProjectFileIndex } from "../project-files.js";
import { buildTreeChoices } from "../session-tree.js";
import type { DiagnosticResult } from "../diagnostics.js";

/**
 * 离线检查（不调 LLM）：`/` 自动补全目录必须含内置命令与 CLI 会提供的
 * 全部内容（提示词模板、扩展命令、技能）。
 */
export async function runSlashCommandTest(cwd: string): Promise<DiagnosticResult[]> {
  try {
    const { session } = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd) });
    const commands = collectSlashCommands(session);
    session.dispose();
    const counts = commands.reduce<Record<string, number>>((acc, command) => {
      acc[command.kind] = (acc[command.kind] ?? 0) + 1;
      return acc;
    }, {});
    return [
      {
        name: "slash commands",
        ok: (counts.builtin ?? 0) > 0,
        detail: `${commands.length} total (${Object.entries(counts)
          .map(([kind, count]) => `${kind}:${count}`)
          .join(", ")})`,
      },
    ];
  } catch (error) {
    return [{ name: "slash commands", ok: false, detail: describe(error) }];
  }
}

/**
 * 离线检查（不调 LLM）：最近会话的会话树必须能摊平为可选条目——那正是
 * `/tree` 与 `/fork` 展示的东西。
 */
export async function runSessionTreeTest(cwd: string): Promise<DiagnosticResult[]> {
  try {
    const sessions = await SessionManager.list(cwd);
    if (sessions.length === 0) {
      return [{ name: "session tree", ok: true, detail: "no saved sessions for this cwd (nothing to navigate)" }];
    }
    const sessionManager = SessionManager.open(sessions[0]!.path);
    const all = buildTreeChoices(sessionManager);
    const userOnly = buildTreeChoices(sessionManager, { userMessagesOnly: true });
    const leafId = sessionManager.getLeafEntry()?.id;
    return [
      {
        name: "session tree",
        ok: all.length > 0 && all.length >= userOnly.length,
        detail: `${all.length} navigable entries, ${userOnly.length} fork points, leaf=${leafId ?? "(none)"}`,
      },
    ];
  } catch (error) {
    return [{ name: "session tree", ok: false, detail: describe(error) }];
  }
}

/** 离线检查：@ 选择器的项目路径发现、过滤与校验。 */
export async function runProjectFilesTest(cwd: string): Promise<DiagnosticResult[]> {
  try {
    const index = new ProjectFileIndex(() => {});
    const items = await index.search(cwd, "", false);
    const sampleFile = items.find((item) => item.kind === "file")?.path;
    const sampleDirectory = items.find((item) => item.kind === "directory")?.path;

    // 路径安全：越界与被排除的大体量路径必须先于 webview 提供的值进入 prompt 被拒。
    let escapeRejected = false;
    try {
      await index.validate(cwd, ["../outside.txt"]);
    } catch {
      escapeRejected = true;
    }
    let excludedRejected = false;
    try {
      await index.validate(cwd, ["node_modules"]);
    } catch {
      excludedRejected = true;
    }

    const validatedFile = sampleFile ? await index.validate(cwd, [sampleFile]) : { paths: [] };
    const validatedDirectory = sampleDirectory
      ? await index.validate(cwd, [sampleDirectory])
      : { paths: [], directories: [] };
    const samplesOk = Boolean(sampleFile)
      && validatedFile.paths.length === 1
      && Boolean(sampleDirectory)
      && validatedDirectory.paths.length === 1
      && validatedDirectory.directories[0] === sampleDirectory;

    return [{
      name: "project files",
      ok: samplesOk && escapeRejected && excludedRejected,
      detail: `indexed=${items.length}, escapeRejected=${escapeRejected}, excludedRejected=${excludedRejected}, file=${sampleFile ?? "n/a"}, directory=${sampleDirectory ?? "n/a"}`,
    }];
  } catch (error) {
    return [{ name: "project files", ok: false, detail: describe(error) }];
  }
}
