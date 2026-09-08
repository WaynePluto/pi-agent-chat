/** 视图状态机、会话所有权与启动会话的自检。 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { ChatBridge } from "../bridge.js";
import { readContentMaxWidth, readFoldLines, readWideThreshold } from "../config.js";
import { OriginalContentProvider } from "../diff-view.js";
import { describe } from "../errors.js";
import { PiRuntime, type StartupSession } from "../runtime.js";
import { type LaneState, type SubagentRun } from "../subagent.js";
import type { ChatState, HostMessage } from "../../shared/protocol.js";
import { CONTENT_WIDTH_MIN, WIDE_THRESHOLD_MIN } from "../../shared/protocol.js";
import type { DiagnosticResult } from "../diagnostics.js";
import type { StoredMessage } from "./shared.js";

/**
 * 经真实 webview 入口驱动的视图状态机。存在的原因是一个修了三轮的 bug：
 * webview 显示什么曾是三个独立字段，每次修复都只改对其中一部分；最后
 * 一次是 postState() 在 preview 打开时丢掉委派状态，悄悄撤销了刚在
 * 上面算出的框架。这里的要点是一切都不手工拼装：驱动 handleMessage()、
 * 读 postState() 实际 post 出的东西。自己构造 ChatState 的测试——
 * webview 冒烟脚本只能那样——看不见构造它的代码里的 bug。
 */
export async function runViewStateTest(cwd: string): Promise<DiagnosticResult[]> {
  const posted: HostMessage[] = [];
  const lastState = (): ChatState | undefined => {
    for (let i = posted.length - 1; i >= 0; i -= 1) {
      const message = posted[i];
      if (message?.type === "state") return message.state;
    }
    return undefined;
  };
  const lastTranscriptId = (): string | undefined => {
    for (let i = posted.length - 1; i >= 0; i -= 1) {
      const message = posted[i];
      if (message?.type === "history") return message.transcriptId;
    }
    return undefined;
  };

  let runtime: PiRuntime | undefined;
  let child: AgentSession | undefined;
  try {
    runtime = await PiRuntime.create({ cwd, log: () => {} });
    const bridge = new ChatBridge(
      runtime,
      { post: (message) => posted.push(message), log: () => {} },
      new OriginalContentProvider(),
    );
    await bridge.attach();
    const parentTranscript = lastTranscriptId();

    const failures: string[] = [];
    const expect = (label: string, ok: boolean) => {
      if (!ok) failures.push(label);
    };

    const firstHistoryFlag = (): boolean | undefined => {
      for (let i = 0; i < posted.length; i += 1) {
        const message = posted[i];
        if (message?.type === "history") return message.populateInputHistory;
      }
      return undefined;
    };
    const lastHistoryFlag = (): boolean | undefined => {
      for (let i = posted.length - 1; i >= 0; i -= 1) {
        const message = posted[i];
        if (message?.type === "history") return message.populateInputHistory;
      }
      return undefined;
    };

    /* 视图变更不等待其状态快照（void postState()），动作后立刻读
       lastState() 会与它赛跑。轮询直到期望的形状落地——history 与标志
       位是同步投递的，无需等待。 */
    const waitForState = async (predicate: (snapshot: ChatState | undefined) => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 500 && !predicate(lastState()); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    expect("attach: replay populates input history", firstHistoryFlag() === true);

    /* ready 必须在首次历史重放之前交给 webview 折叠阈值与布局几何（同一
       归属规则：webview 读不到 VS Code 设置；两值同行投递，宽窄判定缺一
       不可）。阈值被夹取而非盲信：低于它三栏无法同时满足各自最小宽度，
       布局会切进自己满足不了的形状。清单的 minimum 是派生数的第二份
       拷贝、只有设置界面读它，漂移不报运行时错误，用户只会被允许选一
       个布局满足不了的阈值。 */
    await bridge.handleMessage({ type: "ready" });
    const foldThreshold = [...posted].reverse().find((message) => message?.type === "foldThreshold");
    expect(
      "ready: fold threshold delivered",
      foldThreshold !== undefined && foldThreshold.type === "foldThreshold" && foldThreshold.maxLines === readFoldLines(),
    );
    const contentWidth = [...posted].reverse().find((message) => message?.type === "contentWidth");
    expect(
      "ready: content width delivered",
      contentWidth !== undefined && contentWidth.type === "contentWidth" && contentWidth.maxWidth === readContentMaxWidth(),
    );
    expect(
      "ready: wide threshold delivered",
      contentWidth !== undefined && contentWidth.type === "contentWidth" && contentWidth.wideMinWidth === readWideThreshold(),
    );
    expect("ready: wide threshold clamped to a satisfiable width", readWideThreshold() >= WIDE_THRESHOLD_MIN);
    {
      const manifest = require("../../../package.json") as {
        contributes: { configuration: { properties: Record<string, { minimum?: number }> } };
      };
      const declared = manifest.contributes.configuration.properties["piAgentChat.layout.wideModeMinWidth"]?.minimum;
      expect(
        `manifest wide-threshold floor matches the geometry (${declared} === ${WIDE_THRESHOLD_MIN})`,
        declared === WIDE_THRESHOLD_MIN,
      );
    }
    expect("content width has no ceiling", readContentMaxWidth() >= CONTENT_WIDTH_MIN);
    expect("ready: replay populates input history", lastHistoryFlag() === true);

    const live = lastState();
    expect("live: input enabled", live?.inputDisabled !== true);
    expect("live: not in a lane", live?.delegation?.role !== "child");

    const childResult = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd) });
    child = childResult.session;
    const lane: LaneState = {
      id: "lane-probe",
      title: "probe",
      task: "probe task",
      scope: [],
      status: "running",
      writtenFiles: [],
      scopeViolations: 0,
      deniedPaths: [],
      bashMayHaveWritten: false,
      startedAt: Date.now(),
      sessionId: child.sessionId,
      sessionFile: child.sessionFile,
    };
    const run: SubagentRun = { id: "run-probe", parent: runtime.session, lanes: [lane], startedAt: Date.now() };
    bridge.onRunStarted(run);
    bridge.onLaneStarted(run, lane, child);
    await bridge.handleMessage({ type: "showLane", laneId: lane.id });
    await waitForState((s) => s?.delegation?.role === "child" && s?.inputDisabled === true);
    const inLane = lastState();
    expect("lane: role is child", inLane?.delegation?.role === "child");
    expect("lane: names the lane", inLane?.delegation?.currentLaneId === lane.id);
    expect("lane: read-only", inLane?.inputDisabled === true);
    expect("lane: own transcript", lastTranscriptId() === child.sessionId);
    expect("lane: replay does not re-populate input history", !lastHistoryFlag());

    /* 经横幅按钮的同一路径回到父会话。等待才是「恢复可写」有意义的
       地方：进 lane 之前的状态也可写，只有中间等到过的子会话状态才
       排除它是陈旧匹配。 */
    await bridge.handleMessage({ type: "showLane" });
    await waitForState((s) => s?.inputDisabled !== true);
    const back = lastState();
    expect("back: role is parent", back?.delegation?.role === "parent");
    expect("back: writable again", back?.inputDisabled !== true);
    expect("back: parent transcript", lastTranscriptId() === parentTranscript);
    expect("back to live: replay does not re-populate input history", !lastHistoryFlag());

    const sessions = await SessionManager.list(cwd);
    const other = sessions.find((info) => info.path !== runtime?.session.sessionFile);
    let replayDetail = "skipped (no other session on disk)";
    if (other) {
      await bridge.handleMessage({ type: "showLane", laneId: "gone", sessionFile: other.path, title: "Node version" });
      await waitForState((s) => s?.preview?.file === other.path && s?.delegation?.role === "child");
      const replayed = lastState();
      expect("replayed lane: is a preview", replayed?.preview?.file === other.path);
      expect("replayed lane: still a subagent", replayed?.delegation?.role === "child");
      expect("replayed lane: read-only", replayed?.inputDisabled === true);
      expect("replayed lane: transcript is the file", lastTranscriptId() === other.path);

      await bridge.handleMessage({ type: "showLane" });
      await waitForState((s) => s?.preview === undefined && s?.inputDisabled !== true);
      replayDetail = "historical lane replay framed as subagent";
    }

    bridge.dispose();
    return [{
      name: "view state",
      ok: failures.length === 0,
      detail: failures.length === 0
        ? `live/lane/back transitions consistent; ${replayDetail}`
        : `failed: ${failures.join("; ")}`,
    }];
  } catch (error) {
    return [{ name: "view state", ok: false, detail: describe(error) }];
  } finally {
    child?.dispose();
    runtime?.dispose();
  }
}

/**
 * 任务线运行期间谁拥有一个会话文件的离线检查。上报的 bug：打开子代理
 * 的 transcript 再切到别的会话，父会话变得无主无徽章，会话列表把一条
 * 活的对话当普通行提供——点它就给正在追加的 JSONL 开出第二个 writer，
 * 运行中的任务线也从每个列表消失。所有权与任务线角色因此必须是
 * runtime 的事实而非屏上 transcript 的事实，都在显示着 lane 的真实
 * ChatBridge 上读取——那正是曾把它们弄反的状态。一次性会话目录：这些
 * transcript 不得混进用户的会话列表。
 */
export async function runSessionOwnershipTest(cwd: string): Promise<DiagnosticResult[]> {
  const message = (text: string) =>
    ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }) as StoredMessage;
  let dir: string | undefined;
  let runtime: PiRuntime | undefined;
  let child: AgentSession | undefined;
  const failures: string[] = [];
  const expect = (label: string, ok: boolean) => {
    if (!ok) failures.push(label);
  };
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-ownership-"));
    const parentManager = SessionManager.create(cwd, dir);
    parentManager.appendMessage(message("delegate this"));
    const parentFile = parentManager.getSessionFile();
    const childManager = SessionManager.create(cwd, dir);
    childManager.appendMessage(message("lane task"));
    const childFile = childManager.getSessionFile();
    if (!parentFile || !childFile) {
      return [{ name: "session ownership", ok: false, detail: "session files were not written" }];
    }

    const roleQueries: string[] = [];
    const posted: HostMessage[] = [];
    const lastState = (): ChatState | undefined => {
      for (let i = posted.length - 1; i >= 0; i -= 1) {
        const entry = posted[i];
        if (entry?.type === "state") return entry.state;
      }
      return undefined;
    };
    const waitForState = async (predicate: (snapshot: ChatState | undefined) => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 500 && !predicate(lastState()); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    runtime = await PiRuntime.create({ cwd, startup: { mode: "file", path: parentFile }, log: () => {} });
    const bridge = new ChatBridge(
      runtime,
      {
        post: (hostMessage) => posted.push(hostMessage),
        log: () => {},
        delegationRoleAt: (file) => {
          roleQueries.push(file);
          return undefined;
        },
      },
      new OriginalContentProvider(),
    );
    await bridge.attach();
    // runtime 自己拼写的路径（临时目录可能回来时已被规范化），宿主里的每处比较都用它。
    const ownFile = runtime.session.sessionFile;
    expect("parent session was reopened from its file", ownFile !== undefined);

    const childResult = await createAgentSession({ cwd, sessionManager: childManager });
    child = childResult.session;
    const laneFile = child.sessionFile ?? childFile;
    const lane: LaneState = {
      id: "lane-owned",
      title: "probe",
      task: "probe task",
      scope: [],
      status: "running",
      writtenFiles: [],
      scopeViolations: 0,
      deniedPaths: [],
      bashMayHaveWritten: false,
      startedAt: Date.now(),
      sessionId: child.sessionId,
      sessionFile: laneFile,
    };
    const run: SubagentRun = { id: "run-owned", parent: runtime.session, lanes: [lane], startedAt: Date.now() };
    bridge.onRunStarted(run);
    bridge.onLaneStarted(run, lane, child);

    expect("running: the lane file is owned", bridge.runningLaneFiles().includes(laneFile));
    expect("running: parent role", ownFile !== undefined && bridge.delegationRoleAt(ownFile) === "parent");
    expect("running: child role", bridge.delegationRoleAt(laneFile) === "child");
    expect("running: unrelated file has no role", bridge.delegationRoleAt(join(dir, "nobody.jsonl")) === undefined);

    /* 关键：显示 lane 不得改变所有权的任何事实。该视图 post 出的状态
       确实指向子会话（那正是 webview 显示的东西），而这恰恰说明 claim
       绝不能从它读出。 */
    await bridge.handleMessage({ type: "showLane", laneId: lane.id });
    await waitForState((snapshot) => snapshot?.delegation?.role === "child");
    expect("lane view: state follows the display", lastState()?.sessionFile === laneFile);
    expect("lane view: lane still owned", bridge.runningLaneFiles().includes(laneFile));
    expect("lane view: parent is still the parent", ownFile !== undefined && bridge.delegationRoleAt(ownFile) === "parent");
    expect("lane view: child is still a child", bridge.delegationRoleAt(laneFile) === "child");

    await bridge.handleMessage({ type: "showLane" });
    await waitForState((snapshot) => snapshot?.delegation?.role === "parent");
    await bridge.handleMessage({ type: "showLane", sessionFile: laneFile });
    await waitForState((snapshot) => snapshot?.delegation?.role === "child");
    expect("lane addressed by file lands on that lane", lastState()?.delegation?.currentLaneId === lane.id);

    await bridge.handleMessage({ type: "sessionsVisible", visible: true });
    const listed = [...posted].reverse().find((entry) => entry.type === "sessions");
    const rows = listed?.type === "sessions" ? listed.items.length : 0;
    expect("session list asks the window about every row", rows === 0 || roleQueries.length >= rows);

    lane.status = "completed";
    lane.endedAt = Date.now();
    bridge.onRunFinished(run);
    expect("settled: no lane is owned", bridge.runningLaneFiles().length === 0);
    expect(
      "settled: no roles remain",
      bridge.delegationRoleAt(laneFile) === undefined && (ownFile === undefined || bridge.delegationRoleAt(ownFile) === undefined),
    );

    bridge.dispose();
    return [{
      name: "session ownership",
      ok: failures.length === 0,
      detail: failures.length === 0
        ? `task line owned by its runtime, not by the displayed transcript (${rows} row(s) listed, ${roleQueries.length} role query/queries)`
        : `failed: ${failures.join("; ")}`,
    }];
  } catch (error) {
    return [{ name: "session ownership", ok: false, detail: describe(error) }];
  } finally {
    child?.dispose();
    runtime?.dispose();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 窗口以哪个会话开场的离线检查。需要守护是因为每个错误分支仍会把用户
 * 放进*某个*会话——只是不对的那个，失败是静默的。促成它的情形：全新
 * 会话在首次追加之前不写文件，「用户停在空的全新会话里」只存在于宿主
 * 记忆中，没有它，下次启动会 resume 上一个对话。
 */
export async function runStartupSessionTest(cwd: string): Promise<DiagnosticResult[]> {
  const runtimes: PiRuntime[] = [];
  const remembered: (string | undefined)[] = [];
  const failures: string[] = [];
  const expect = (label: string, ok: boolean) => {
    if (!ok) failures.push(label);
  };
  const lastRemembered = () => remembered[remembered.length - 1];
  try {
    const start = async (startup: StartupSession): Promise<string | undefined> => {
      const runtime = await PiRuntime.create({ cwd, startup, log: () => {} });
      runtimes.push(runtime);
      const bridge = new ChatBridge(
        runtime,
        { post: () => {}, log: () => {}, rememberSession: (file) => remembered.push(file) },
        new OriginalContentProvider(),
      );
      await bridge.attach();
      bridge.dispose();
      return runtime.session.sessionFile;
    };

    const fresh = await start({ mode: "new" });
    expect("new: file not written yet", fresh !== undefined && !existsSync(fresh));
    expect("new: remembered as a fresh session", remembered.length === 1 && lastRemembered() === undefined);

    const sessions = await SessionManager.list(cwd);
    let fileDetail = "skipped (no session on disk)";
    if (sessions.length > 0) {
      const target = sessions[sessions.length - 1]!.path;
      const opened = await start({ mode: "file", path: target });
      expect("file: reopened the remembered session", opened === target);
      expect("file: remembered the same path", lastRemembered() === target);
      fileDetail = `reopened the oldest of ${sessions.length} session(s)`;
    }

    // 记住的文件可能在两次窗口之间被删：必须降级到最近的会话，而不是开一个钉死在死路径上的空会话（那会重建用户刚删的文件）。
    const missing = join(cwd, "pi-agent-chat-missing-session.jsonl");
    const fallback = await start({ mode: "file", path: missing });
    expect("missing file: not reused", fallback !== missing);
    expect(
      "missing file: fell back to the most recent session",
      sessions.length === 0 ? !existsSync(fallback ?? "") : sessions.some((info) => info.path === fallback),
    );

    return [
      {
        name: "startup session",
        ok: failures.length === 0,
        detail:
          failures.length === 0
            ? `new=unwritten; file=${fileDetail}; missing file=fell back`
            : `failed: ${failures.join("; ")}`,
      },
    ];
  } catch (error) {
    return [{ name: "startup session", ok: false, detail: describe(error) }];
  } finally {
    for (const runtime of runtimes) runtime.dispose();
  }
}
