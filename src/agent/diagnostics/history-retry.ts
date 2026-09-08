/** 历史回放与手动重试提议生命周期的自检。 */
import { rm } from "node:fs/promises";
import { createAgentSession, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { ChatBridge } from "../bridge.js";
import { OriginalContentProvider } from "../diff-view.js";
import { describe } from "../errors.js";
import { buildHistoryEntryEvents } from "../history.js";
import { isResumable, resumeAfterError, supportsResume } from "../resume.js";
import { PiRuntime } from "../runtime.js";
import type { HostMessage } from "../../shared/protocol.js";
import type { DiagnosticResult } from "../diagnostics.js";
import { createFailedResponseSession, type StoredMessage } from "./shared.js";

/**
 * 离线检查（不调 LLM）：resume 该 cwd 最近的会话，验证持久化 transcript
 * 能映射为可渲染的聊天事件。
 */
export async function runHistoryReplayTest(cwd: string): Promise<DiagnosticResult[]> {
  try {
    const sessions = await SessionManager.list(cwd);
    if (sessions.length === 0) {
      return [{ name: "history replay", ok: true, detail: "no saved sessions for this cwd (nothing to replay)" }];
    }
    const { session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.open(sessions[0]!.path),
    });
    const contextMessageCount = session.messages.length;
    const branchEntries = session.sessionManager.getBranch();
    const events = buildHistoryEntryEvents(branchEntries, cwd);
    session.dispose();
    const counts = events.reduce<Record<string, number>>((acc, event) => {
      acc[event.kind] = (acc[event.kind] ?? 0) + 1;
      return acc;
    }, {});
    return [
      {
        name: "history replay",
        ok: events.length > 0,
        detail: `${sessions.length} session(s); newest -> ${branchEntries.length} branch entries, ${contextMessageCount} context messages, ${events.length} events (${
          Object.entries(counts)
            .map(([kind, count]) => `${kind}:${count}`)
            .join(", ") || "none"
        })`,
      },
    ];
  } catch (error) {
    return [{ name: "history replay", ok: false, detail: describe(error) }];
  }
}

/**
 * 离线检查（不调 LLM）：resume 自动重试已放弃的那一轮。钉两件事：resume
 * 依赖的 SDK 入口是私有的（agent/resume.ts 说明了原因），上游改名必须在
 * 这里显形，而不是变成悄悄失灵的按钮；resume 必须无损——只丢失败响应、
 * 只丢它，再以空消息批重发（编造「继续」正是它要避免的）。正常结束的
 * 轮次不是候选：重跑会丢掉屏幕上的答案。抛在产出前的请求留下悬空
 * user 尾巴，仍走同一空批路径。运行以桩代之；真实请求是 live 测试的事。
 */
export async function runManualRetryTest(cwd: string): Promise<DiagnosticResult[]> {
  type Runner = { _runAgentPrompt: (messages: unknown[]) => Promise<void> };
  const user = (text: string): StoredMessage => ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  }) as StoredMessage;
  const assistant = (stopReason: string): StoredMessage => ({
    role: "assistant",
    content: [],
    stopReason,
    errorMessage: stopReason === "error" ? "Connection error." : undefined,
    timestamp: Date.now(),
  }) as unknown as StoredMessage;
  const open = async (messages: StoredMessage[]): Promise<AgentSession> => {
    const manager = SessionManager.inMemory(cwd);
    for (const message of messages) manager.appendMessage(message);
    return (await createAgentSession({ cwd, tools: [], sessionManager: manager })).session;
  };
  const sessions: AgentSession[] = [];
  try {
    const failed = await open([user("first"), assistant("error")]);
    sessions.push(failed);
    const mechanism = supportsResume(failed);
    const afterFailure = isResumable(failed);

    const succeeded = await open([user("first"), assistant("stop")]);
    sessions.push(succeeded);
    const afterSuccess = isResumable(succeeded);

    /* 回归：error -> user -> error 仍须提供重试，即使 Pi 的自动重试已把
       最后一个错误从 agent state 移除。活动 SessionManager 分支才是
       transcript 展示的东西，因此是「轮次被打断」的事实源。 */
    const repeated = await open([user("first"), assistant("error"), user("second"), assistant("error")]);
    sessions.push(repeated);
    repeated.agent.state.messages = repeated.agent.state.messages.slice(0, -1);
    const afterRepeatedFailure = isResumable(repeated);

    const thrown = await open([user("first"), assistant("error"), user("second")]);
    sessions.push(thrown);
    const afterThrownFailure = isResumable(thrown);

    let batch: unknown[] | undefined;
    (failed as unknown as Runner)._runAgentPrompt = async (messages) => {
      batch = messages;
    };
    const resumed = await resumeAfterError(failed);
    const left = failed.agent.state.messages;

    const ok =
      mechanism &&
      afterFailure &&
      !afterSuccess &&
      afterRepeatedFailure &&
      afterThrownFailure &&
      resumed &&
      Array.isArray(batch) &&
      batch.length === 0 &&
      left.length === 1 &&
      left[0]?.role === "user";
    return [{
      name: "manual retry",
      ok,
      detail: `sdk prompt path=${mechanism ? "present" : "MISSING"}; failed=${afterFailure ? "resumable" : "NOT OFFERED"}; completed=${afterSuccess ? "WRONGLY OFFERED" : "not offered"}; error-user-error=${afterRepeatedFailure ? "resumable" : "NOT OFFERED"}; dangling user=${afterThrownFailure ? "resumable" : "NOT OFFERED"}; resumed=${resumed}; re-issued with ${batch?.length ?? "n/a"} new message(s); agent state left with ${left.map((message) => message.role).join(",") || "nothing"}`,
    }];
  } catch (error) {
    return [{ name: "manual retry", ok: false, detail: describe(error) }];
  } finally {
    for (const session of sessions) session.dispose();
  }
}

/**
 * 离线检查（不调 LLM）：重开一个死在请求中途的会话仍必须给出重试提议。
 * live 提议是 transcript 事件，只存在于看着运行失败的窗口；别的窗口后来
 * 打开同一会话，从文件回放时失败只是一条裸的供方错误（"Request timed
 * out."）、无处可点。本检查覆盖整条路径：从停在失败响应上的会话文件，
 * 经 PiRuntime 与真实的 ChatBridge.attach()，直到实际 post 出的 history
 * 消息。供方错误本身也必须幸存——提议解释下一步做什么，不解释哪里错了。
 */
export async function runReplayedRetryOfferTest(cwd: string): Promise<DiagnosticResult[]> {
  let dir: string | undefined;
  let runtime: PiRuntime | undefined;
  try {
    const fixture = await createFailedResponseSession(cwd, "pi-vscode-retry-replay-");
    dir = fixture.dir;
    const file = fixture.file;
    if (!file) return [{ name: "replayed retry offer", ok: false, detail: "session file was not written" }];

    const posted: HostMessage[] = [];
    runtime = await PiRuntime.create({ cwd, startup: { mode: "file", path: file }, log: () => {} });
    const bridge = new ChatBridge(
      runtime,
      { post: (message) => posted.push(message), log: () => {} },
      new OriginalContentProvider(),
    );
    await bridge.attach();
    const resumable = isResumable(runtime.session);
    bridge.dispose();

    const replayed = [...posted].reverse().find((message) => message.type === "history");
    const events = replayed?.type === "history" ? replayed.events : [];
    const last = events[events.length - 1];
    const offered = last?.kind === "status" && last.retry === "offered";
    const keptError = events.some((event) => event.kind === "error" && event.text.includes("Request timed out."));

    return [{
      name: "replayed retry offer",
      ok: resumable && offered && keptError,
      detail: `reopened from file: state=${resumable ? "resumable" : "NOT RESUMABLE"}; replayed ${events.length} event(s) ending on ${last?.kind ?? "nothing"}${offered ? " with retry" : " WITHOUT retry"}; provider error ${keptError ? "kept" : "LOST"}`,
    }];
  } catch (error) {
    return [{ name: "replayed retry offer", ok: false, detail: describe(error) }];
  } finally {
    runtime?.dispose();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 离线检查（不调 LLM）：重试提议必须在 transcript 上收敛。按钮由宿主放
 * 在提示上的状态画出，整个生命周期在宿主侧、webview 冒烟看不见。钉住
 * 上报过的多请求情形：重试先拿到成功的工具请求响应、其下一次供方调用
 * 超时——被点的提议收敛为 succeeded，后来的超时自领新提议；重试新失败
 * 而无成功响应时只把新提议收敛为 failed。状态还须挺过回放。live 的
 * message_end(error) 本身要携带足够类型化证据，SessionManager 尾巴仍停
 * 在前一条成功响应上时也能在 settle 产出提议（上报过的「超时卡片无按钮」）。
 */
export async function runRetryOfferLifecycleTest(cwd: string): Promise<DiagnosticResult[]> {
  type Runner = { _runAgentPrompt: (messages: unknown[]) => Promise<void> };
  const name = "retry offer lifecycle";
  let dir: string | undefined;
  let runtime: PiRuntime | undefined;
  try {
    const fixture = await createFailedResponseSession(cwd, "pi-vscode-retry-lifecycle-");
    dir = fixture.dir;
    const file = fixture.file;
    if (!file) return [{ name, ok: false, detail: "session file was not written" }];

    const posted: HostMessage[] = [];
    runtime = await PiRuntime.create({ cwd, startup: { mode: "file", path: file }, log: () => {} });
    const bridge = new ChatBridge(
      runtime,
      { post: (message) => posted.push(message), log: () => {} },
      new OriginalContentProvider(),
    );
    await bridge.attach();
    type EventReceiver = { onSessionEvent: (session: AgentSession, event: unknown) => void };
    const receive = (event: unknown) => {
      (bridge as unknown as EventReceiver).onSessionEvent(runtime!.session, event);
    };
    const response = (stopReason: "stop" | "toolUse" | "error", text: string): StoredMessage => ({
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      api: "anthropic-messages",
      provider: "probe-provider",
      model: "probe-model",
      usage: {
        input: 0,
        output: text ? 1 : 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: text ? 1 : 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      errorMessage: stopReason === "error" ? "Request timed out." : undefined,
      timestamp: Date.now(),
    } as unknown as StoredMessage);
    const append = (message: StoredMessage) => {
      runtime!.session.agent.state.messages.push(message);
      runtime!.session.sessionManager.appendMessage(message);
    };

    // 重试 A 拿到合法的工具请求响应，随后工具活动后的供方调用超时；A 成功，超时归提议 B。
    (runtime.session as unknown as Runner)._runAgentPrompt = async () => {
      const toolRequest = response("toolUse", "calling tool");
      runtime!.session.agent.state.messages.push(toolRequest);
      receive({ type: "message_end", message: toolRequest });
      runtime!.session.sessionManager.appendMessage(toolRequest);
      append({
        role: "toolResult",
        toolCallId: "probe-call",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: Date.now(),
      } as unknown as StoredMessage);
      const laterFailure = response("error", "");
      runtime!.session.agent.state.messages.push(laterFailure);
      receive({ type: "message_end", message: laterFailure });
      runtime!.session.sessionManager.appendMessage(laterFailure);
      receive({ type: "agent_settled" });
    };
    posted.length = 0;
    await bridge.handleMessage({ type: "retry" });
    const duringRun = retryStates(posted).includes("running");
    const afterPartialSuccess = latestRetryStates(posted);

    // 回放必须保留 A 的已花费状态，并独立重建 B。
    posted.length = 0;
    await bridge.attach();
    const afterReplay = latestRetryStates(posted);

    // 重试 B 拿不到任何成功响应：B 失败、新打断归提议 C；A 不得被 B 的下场改写。
    (runtime.session as unknown as Runner)._runAgentPrompt = async () => {
      const failure = response("error", "");
      runtime!.session.agent.state.messages.push(failure);
      receive({ type: "message_end", message: failure });
      runtime!.session.sessionManager.appendMessage(failure);
      receive({ type: "agent_settled" });
    };
    posted.length = 0;
    await bridge.handleMessage({ type: "retry" });
    const afterFailedRetry = latestRetryStates(posted);

    /* 显示中的 live 错误在 message_end 已是类型化事实。故意把持久尾巴
       （成功响应）留到 agent_settled 之后仍过期：提议必须跟着 live 错误
       走，而不是因 buildSessionContext() 尚未暴露新尾巴而消失。 */
    append({
      role: "user",
      content: [{ type: "text", text: "next" }],
      timestamp: Date.now(),
    } as StoredMessage);
    append(response("stop", "ok"));
    const racingFailure = response("error", "");
    runtime.session.agent.state.messages.push(racingFailure);
    posted.length = 0;
    receive({ type: "message_end", message: racingFailure });
    const durableBeforeLiveSettle = isResumable(runtime.session);
    receive({ type: "agent_settled" });
    const liveRaceOffered = retryStates(posted).at(-1) === "offered";
    bridge.dispose();

    const expectedFirst = afterPartialSuccess.join(",") === "succeeded,offered";
    const expectedReplay = afterReplay.join(",") === "succeeded,offered";
    const expectedSecond = afterFailedRetry.join(",") === "succeeded,failed,offered";
    const ok = duringRun && expectedFirst && expectedReplay && expectedSecond && !durableBeforeLiveSettle && liveRaceOffered;
    return [{
      name,
      ok,
      detail: `while running=${duringRun ? "running" : "NOT MARKED"}; after tool success + later timeout=${afterPartialSuccess.join(",") || "nothing"}; after replay=${afterReplay.join(",") || "nothing"}; after retry without success=${afterFailedRetry.join(",") || "nothing"}; live timeout with stale durable tail=${durableBeforeLiveSettle ? "WRONGLY DURABLE" : liveRaceOffered ? "offered from event" : "OFFER LOST"}`,
    }];
  } catch (error) {
    return [{ name, ok: false, detail: describe(error) }];
  } finally {
    runtime?.dispose();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function retryStates(posted: readonly HostMessage[]): string[] {
  return posted.flatMap((message) => {
    const events = message.type === "history" ? message.events : message.type === "event" ? [message.event] : [];
    return events.flatMap((event) => (event.kind === "status" && event.retry ? [event.retry] : []));
  });
}

function latestRetryStates(posted: readonly HostMessage[]): string[] {
  const history = [...posted].reverse().find((message) => message.type === "history");
  if (!history || history.type !== "history") return [];
  return history.events.flatMap((event) => (
    event.kind === "status" && event.retry ? [event.retry] : []
  ));
}
