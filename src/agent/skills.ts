import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import type { SkillRef } from "../shared/protocol.js";

/**
 * Recognizes when a tool call touches a skill.
 *
 * The SDK emits no "skill loaded" event: a skill the model picks up on its own
 * is just a `read` of its `SKILL.md` (progressive disclosure, see the SDK's
 * `docs/skills.md`). To tell that read apart from any other file read, the
 * chat matches tool arguments against the absolute skill paths the resource
 * loader already knows.
 */

interface SkillEntry {
  name: string;
  /** Normalized absolute path of SKILL.md. */
  file: string;
  /**
   * Normalized skill directory with a trailing slash, or undefined for
   * single-file skills (`~/.pi/agent/skills/foo.md`), whose `baseDir` is the
   * shared skills root and would match unrelated files.
   */
  dir?: string;
}

export type SkillIndex = readonly SkillEntry[];

export const EMPTY_SKILL_INDEX: SkillIndex = [];

/** Snapshot the loaded skills; rebuild after a session swap or `/reload`. */
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
 * Attribute a tool call to a skill, or undefined when unrelated.
 *
 * Only argument shapes that genuinely denote a filesystem target are inspected:
 * the `path` argument of the file tools and `bash` command lines (skills ship
 * helper scripts). Free-text arguments such as the subagent task are ignored so
 * that merely mentioning a skill path cannot mislabel a call.
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
 * `session.prompt()` persists `/skill:<name>` invocations already expanded into
 * the full `<skill>` block, so anything replaying stored text (transcript,
 * session list, session-tree preview, editor restore) would show the whole
 * skill file instead of the short command the user typed. Collapse it back to
 * the original command, mirroring what the live stream emitted.
 */
export function collapseSkillInvocation(text: string): string {
  const block = parseSkillBlock(text);
  if (!block) return text;
  return block.userMessage ? `/skill:${block.name} ${block.userMessage}` : `/skill:${block.name}`;
}

function skillPathArgument(args: unknown, cwd: string): string | undefined {
  const path = (args as { path?: unknown } | undefined)?.path;
  if (typeof path !== "string" || !path.trim()) return undefined;
  return isAbsolute(path) ? path : resolvePath(cwd, path);
}

/**
 * Compare paths the way the platform does: forward slashes everywhere, and
 * case-insensitive on Windows (the model often echoes a different casing than
 * the loader recorded).
 */
function normalize(value: string): string {
  const slashed = value.replace(/\\/g, "/");
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
}
