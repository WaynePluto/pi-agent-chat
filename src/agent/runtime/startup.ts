import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe } from "../errors.js";
import type { StartupSession } from "./types.js";

/**
 * 将 `startup` 解析到会话目录。
 *
 * 记住的文件可能已消失（从会话页删除，或被另一宿主删除）；这是预期情况，
 * 降级到最新会话即可，不必让整个启动失败。
 */
export function createSessionManager(
  cwd: string,
  startup: StartupSession | undefined,
  log: (message: string) => void,
): SessionManager {
  if (startup?.mode === "file") {
    try {
      // 对不存在的路径，`SessionManager.open()` 会静默地启动一个钉在该路径的
      // 空会话，重新造出用户已删除的文件，所以存在性检查必须放在这里。
      if (existsSync(startup.path)) return SessionManager.open(startup.path);
      log(`last session file is gone; continuing the most recent session instead: ${startup.path}`);
    } catch (error) {
      log(`cannot reopen ${startup.path} (${describe(error)}); continuing the most recent session instead`);
    }
    return SessionManager.continueRecent(cwd);
  }
  if (startup?.mode === "recent") return SessionManager.continueRecent(cwd);
  return SessionManager.create(cwd);
}
