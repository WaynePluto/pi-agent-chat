import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import type { SkillRef } from "../shared/protocol.js";

/**
 * 识别工具调用何时触及技能。
 *
 * SDK 不发「技能已加载」事件：模型自己捡起的技能只是一次对其 `SKILL.md`
 * 的 `read`（渐进披露，见 SDK `docs/skills.md`）。为了把这次 read 与别的
 * 文件读取区分开，这里把工具参数与 resource loader 已知的技能绝对路径
 * 做匹配。
 */

interface SkillEntry {
  name: string;
  /** SKILL.md 的规范化绝对路径。 */
  file: string;
  /**
   * 带尾斜杠的规范化技能目录；单文件技能
   * （`~/.pi/agent/skills/foo.md`）为 undefined——其 `baseDir` 是共享的
   * skills 根目录，会误匹配无关文件。
   */
  dir?: string;
}

export type SkillIndex = readonly SkillEntry[];

export const EMPTY_SKILL_INDEX: SkillIndex = [];

/** SDK-MIRROR: `AgentSession._expandSkillCommand` 里的 `/skill:` 命令前缀。 */
const SKILL_COMMAND_PREFIX = "/skill:";

/** 给已加载技能拍快照；会话替换或 `/reload` 后重建。 */
export function buildSkillIndex(session: AgentSession): SkillIndex {
  try {
    return session.resourceLoader.getSkills().skills.map((skill) => ({
      name: skill.name,
      file: normalize(skill.filePath),
      dir: basename(skill.filePath).toLowerCase() === "skill.md" ? `${normalize(skill.baseDir)}/` : undefined,
    }));
  } catch {
    return EMPTY_SKILL_INDEX;
  }
}

/**
 * 把工具调用归因到某个技能；无关则返回 undefined。
 *
 * 只检查真正指涉文件系统目标的参数形状：文件工具的 `path` 参数与
 * `bash` 命令行（技能自带辅助脚本）。subagent 的 task 这类自由文本参数
 * 被忽略，免得仅仅提到某个技能路径就把调用贴错标签。
 */
export function matchSkill(index: SkillIndex, toolName: string, args: unknown, cwd: string): SkillRef | undefined {
  if (index.length === 0) return undefined;

  const path = skillPathArgument(args, cwd);
  if (path) {
    const target = normalize(path);
    const exact = index.find((entry) => entry.file === target);
    if (exact) return { name: exact.name, kind: "load" };
    const inside = index.find((entry) => entry.dir && target.startsWith(entry.dir));
    return inside ? { name: inside.name, kind: "resource" } : undefined;
  }

  if (toolName === "bash") {
    const command = (args as { command?: unknown } | undefined)?.command;
    if (typeof command !== "string") return undefined;
    const haystack = normalize(command);
    const entry = index.find((skill) => (skill.dir ? haystack.includes(skill.dir) : haystack.includes(skill.file)));
    return entry ? { name: entry.name, kind: "resource" } : undefined;
  }

  return undefined;
}

/**
 * `session.prompt()` 把 `/skill:<name>` 调用展开成完整 `<skill>` 块后才
 * 落盘，任何回放存盘文本的界面（transcript、会话列表、会话树预览、
 * 编辑器恢复）都会展示整份技能文件而非用户敲的短命令。这里把它折回
 * 原命令，与实时流发的内容对齐。
 */
export function collapseSkillInvocation(text: string): string {
  return readSkillInvocation(text).text;
}

/**
 * 折叠 `<skill>` 块并报告它来自哪个技能。
 *
 * `/skill:<name>` 在 prompt 提交前就被 SDK 展开（它自己去读 `SKILL.md`），
 * 所以与模型自主发现的技能不同，没有可归因的 `read` 工具调用。技能名
 * 随用户消息走，transcript 仍能显示该技能确实被加载过。
 */
export function readSkillInvocation(text: string): { text: string; skill?: string } {
  const block = parseSkillBlock(text);
  if (!block) return { text };
  return {
    text: block.userMessage ? `/skill:${block.name} ${block.userMessage}` : `/skill:${block.name}`,
    skill: block.name,
  };
}

/**
 * `/skill:<name> [参数]` 命令所指的技能，且确实已加载才算。
 *
 * 用于实时路径，那里发出的文本仍是用户敲的命令：SDK 要等 `prompt()`
 * 才展开。未知名会被 SDK 当纯文本放行，不得标成技能。
 */
export function invokedSkill(index: SkillIndex, text: string): string | undefined {
  if (!text.startsWith(SKILL_COMMAND_PREFIX)) return undefined;
  const spaceIndex = text.indexOf(" ");
  const name = spaceIndex === -1 ? text.slice(SKILL_COMMAND_PREFIX.length) : text.slice(SKILL_COMMAND_PREFIX.length, spaceIndex);
  return index.some((entry) => entry.name === name) ? name : undefined;
}

function skillPathArgument(args: unknown, cwd: string): string | undefined {
  const path = (args as { path?: unknown } | undefined)?.path;
  if (typeof path !== "string" || !path.trim()) return undefined;
  return isAbsolute(path) ? path : resolvePath(cwd, path);
}

/**
 * 按平台的方式比较路径：统一正斜杠，Windows 下不区分大小写
 * （模型回显的大小写常与 loader 记录的不同）。
 */
function normalize(value: string): string {
  const slashed = value.replace(/\\/g, "/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}
