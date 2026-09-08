import type { StartupSession } from "../agent/runtime.js";
import type { ChatState, WebviewMessage } from "../shared/protocol.js";
import { MAX_EDITOR_TAB_TITLE_CHARS } from "./types.js";

/**
 * 窗口重载前某个编辑区 tab 显示的会话。
 *
 * 编辑区 tab 把自己的会话记在 webview state（`deserializeWebviewPanel` 的
 * 第二个参数）而不是一个 workspace 级键里：VS Code 逐个恢复保留的 panel，
 * N 个 tab 需要 N 份记忆，共用一个键必然互相覆盖。
 */
export function restoredSessionFile(state: unknown, cwd: string): string | undefined {
  if (state === null || typeof state !== "object") return undefined;
  const session = (state as { session?: unknown }).session;
  if (session === null || typeof session !== "object") return undefined;
  const { cwd: storedCwd, file } = session as { cwd?: unknown; file?: unknown };
  if (typeof file !== "string" || file.length === 0) return undefined;
  if (typeof storedCwd === "string" && storedCwd !== cwd) return undefined;
  return file;
}

/** 由宿主自检钉住的纯生命周期规则。 */
export function shouldDisposeHeadlessRuntime(options: {
  disposeWhenSettled: boolean;
  visible: boolean;
  busy: boolean;
  retainedSidebar: boolean;
}): boolean {
  return options.disposeWhenSettled && !options.visible && !options.busy && !options.retainedSidebar;
}

/** 由宿主自检钉住的纯分发规则。 */
export function replacementStartupForRunningController(
  message: WebviewMessage,
  busy: boolean,
  claimedFile?: string,
): StartupSession | undefined {
  if (!busy) return undefined;
  if (message.type === "newSession") return { mode: "new" };
  if (message.type === "resumeSession" && message.file !== claimedFile) return { mode: "file", path: message.file };
  return undefined;
}

/** 被可见 controller claim 的会话会留下真实 GUI，来源面因此拿一个新会话。 */
export function claimedSessionSourceStartup(location: "visible" | "background"): StartupSession | undefined {
  return location === "visible" ? { mode: "new" } : undefined;
}

/**
 * 没有消息的会话不值得搬到别的 surface：每个目标区域都有「在…新开会话」菜
 * 单项，那正是移动空会话的实际含义。控制「移动会话」命令的可见性（见
 * `updateMoveMenuContext`）。
 */
export function isMovableSessionState(state: ChatState | undefined): boolean {
  return (state?.messageCount ?? 0) > 0;
}

/** 孤立 tab 同样保持紧凑；VS Code 只在多个 tab 争抢空间时才截断标题。 */export function editorPanelTitle(sessionName: string | undefined): string {
  const title = sessionName ? `${sessionName} — Pi` : "Pi Agent Chat";
  const characters = [...title];
  if (characters.length <= MAX_EDITOR_TAB_TITLE_CHARS) return title;
  return `${characters.slice(0, MAX_EDITOR_TAB_TITLE_CHARS - 3).join("")}...`;
}
