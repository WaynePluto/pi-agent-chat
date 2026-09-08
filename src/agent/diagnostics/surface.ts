/** 聊天 surface 协调自检。 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimedSessionSourceStartup, editorPanelTitle, isMovableSessionState, MAX_EDITOR_TAB_TITLE_CHARS, ownedSessionFiles, replacementStartupForRunningController, restoredSessionFile, SessionClaimRegistry, shouldDisposeHeadlessRuntime } from "../../chat-surfaces.js";
import type { DiagnosticResult } from "../diagnostics.js";

/**
 * 来自 `vscode-pi-design.md` §3 与 §8 的探针风险检查：原生模块加载、
 * jiti 加载 `.ts` 扩展、undici 别名。
 */
export function runSurfaceCoordinationTest(): DiagnosticResult[] {
  const claims = new SessionClaimRegistry<object>();
  const first = {};
  const second = {};
  const file = join(tmpdir(), "pi-surface-claim.jsonl");
  const firstClaim = claims.claim(file, first);
  const collisionRejected = !claims.claim(file, second) && claims.owner(file) === first;
  claims.release(file, second);
  const wrongOwnerDidNotRelease = claims.owner(file) === first;
  claims.release(file, first);
  const released = claims.claim(file, second) && claims.owner(file) === second;

  const runningHeadlessRetained = !shouldDisposeHeadlessRuntime({
    disposeWhenSettled: true,
    visible: false,
    busy: true,
    retainedSidebar: false,
  });
  const settledHeadlessDisposed = shouldDisposeHeadlessRuntime({
    disposeWhenSettled: true,
    visible: false,
    busy: false,
    retainedSidebar: false,
  });
  const visibleRetained = !shouldDisposeHeadlessRuntime({
    disposeWhenSettled: true,
    visible: true,
    busy: false,
    retainedSidebar: false,
  });
  const sidebarRetained = !shouldDisposeHeadlessRuntime({
    disposeWhenSettled: true,
    visible: false,
    busy: false,
    retainedSidebar: true,
  });
  const replacementNew = replacementStartupForRunningController({ type: "newSession" }, true)?.mode === "new";
  const replacementFile = replacementStartupForRunningController(
    { type: "resumeSession", file: "other.jsonl" },
    true,
    "current.jsonl",
  );
  const selectedSessionBecomesLive = replacementFile?.mode === "file" && replacementFile.path === "other.jsonl";
  const ownSessionDoesNotDuplicate = replacementStartupForRunningController(
    { type: "resumeSession", file: "current.jsonl" },
    true,
    "current.jsonl",
  ) === undefined;
  const idleSessionUsesExistingController = replacementStartupForRunningController(
    { type: "resumeSession", file: "other.jsonl" },
    false,
    "current.jsonl",
  ) === undefined;
  const longTabTitle = editorPanelTitle("A".repeat(MAX_EDITOR_TAB_TITLE_CHARS * 2));
  const editorTabTitleIsCapped = [...longTabTitle].length === MAX_EDITOR_TAB_TITLE_CHARS && longTabTitle.endsWith("...");
  const shortTabTitleIsUntouched = editorPanelTitle("Short") === "Short — Pi";
  const visibleMoveLeavesFreshSource = claimedSessionSourceStartup("visible")?.mode === "new";
  const backgroundMoveHasNoSource = claimedSessionSourceStartup("background") === undefined;
  // 「移动此会话」菜单的可见性：只有带消息的会话才提供移动（见 updateMoveMenuContext 的 context key）。
  const emptySessionNotMovable = !isMovableSessionState(undefined)
    && !isMovableSessionState({ ready: true, isStreaming: false, isCompacting: false, messageCount: 0 });
  const transcriptSessionMovable = isMovableSessionState({ ready: true, isStreaming: false, isCompacting: false, messageCount: 2 });
  // 按 tab 的会话记忆：每个聊天 tab 从自己的 webview state 恢复自己的会话（共享的 workspace 槽会被 N 个 tab 互相覆盖）。
  const cwd = tmpdir();
  const tabRemembersOwnSession = restoredSessionFile({ session: { cwd, file: "a.jsonl" } }, cwd) === "a.jsonl";
  const foreignCwdIgnored = restoredSessionFile({ session: { cwd: join(cwd, "other"), file: "a.jsonl" } }, cwd) === undefined;
  const emptyStateIgnored = restoredSessionFile(undefined, cwd) === undefined
    && restoredSessionFile({ contentMaxWidth: 950 }, cwd) === undefined
    && restoredSessionFile({ session: { cwd, file: "" } }, cwd) === undefined;
  /* 所有权只看「谁在写」：运行中的 lane 被 claim（子代理正追加的文件
     不允许别人 resume），controller 仅「显示」的 lane 不算（那会放掉
     它自己的文件，让第二个 writer resume 活动会话）。 */
  const ownsItsOwnSessionAndRunningLanes = ownedSessionFiles({
    sessionFile: "parent.jsonl",
    runningLaneFiles: ["lane-a.jsonl", "lane-b.jsonl"],
  }).join(",") === "parent.jsonl,lane-a.jsonl,lane-b.jsonl";
  const finishedLanesAreOrdinarySessions = ownedSessionFiles({ sessionFile: "parent.jsonl" }).join(",") === "parent.jsonl";
  const emptySessionOwnsOnlyItsLanes = ownedSessionFiles({ runningLaneFiles: ["lane-a.jsonl"] }).join(",") === "lane-a.jsonl";
  const ok = firstClaim && collisionRejected && wrongOwnerDidNotRelease && released
    && runningHeadlessRetained && settledHeadlessDisposed && visibleRetained && sidebarRetained
    && replacementNew && selectedSessionBecomesLive && ownSessionDoesNotDuplicate && idleSessionUsesExistingController
    && editorTabTitleIsCapped && shortTabTitleIsUntouched
    && visibleMoveLeavesFreshSource && backgroundMoveHasNoSource
    && emptySessionNotMovable && transcriptSessionMovable
    && ownsItsOwnSessionAndRunningLanes && finishedLanesAreOrdinarySessions && emptySessionOwnsOnlyItsLanes
    && tabRemembersOwnSession && foreignCwdIgnored && emptyStateIgnored;
  return [{
    name: "chat surface coordination",
    ok,
    detail: ok
      ? "claims are exclusive and cover running lanes; claimed sessions move to the requesting surface with a fresh visible source; background runs survive until settle; each tab restores its own session"
      : "claim ownership, running-lane ownership, claimed-session transfer, tab-title cap, per-tab session memory or headless runtime lifecycle invariant failed",
  }];
}
