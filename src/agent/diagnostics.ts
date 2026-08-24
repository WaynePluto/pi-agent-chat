import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, createAgentSessionFromServices, createAgentSessionServices, getAgentDir, getPackageDir, SessionManager, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildHistoryEntryEvents, ChatBridge, collectResourceSections } from "./bridge.js";
import { collectSlashCommands } from "./commands.js";
import { OriginalContentProvider } from "./diff-view.js";
import { describe } from "./errors.js";
import { createSubagentServices, findShadowedExtensionTool, PiRuntime, type StartupSession } from "./runtime.js";
import { buildTreeChoices } from "./session-tree.js";
import { SubagentCoordinator, SUBAGENT_TOOL, planModel, type LaneState, type SubagentRun } from "./subagent.js";
import { findScopeConflict, normalizeScopes, ScopeGuard } from "./scope.js";
import { createScopedFileTools } from "./scoped-tools.js";
import {
  VsCodeTerminalPool,
  VSCODE_TERMINAL_TOOL,
  type DisposableLike,
  type ExecutionLike,
  type ShellIntegrationLike,
  type TerminalApi,
  type TerminalLike,
  type TerminalTimeouts,
} from "./vscode-terminal.js";
import { ProjectFileIndex } from "./project-files.js";
import { isResumable, resumeAfterError, supportsResume } from "./resume.js";
import { readFoldLines } from "./config.js";
import type { ChatState, HostMessage } from "../shared/protocol.js";
import { claimedSessionSourceStartup, editorPanelTitle, MAX_EDITOR_TAB_TITLE_CHARS, replacementStartupForRunningController, SessionClaimRegistry, shouldDisposeHeadlessRuntime } from "../chat-surfaces.js";

/** Injected by esbuild (see esbuild.mjs). */
declare const __PI_UNDICI_VERSION__: string;
declare const __PI_SDK_VERSION__: string;

export interface DiagnosticResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Spike risk checks from `vscode-pi-design.md` §3 and §8:
 * native module load, jiti `.ts` extension loading, and the undici alias.
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
  const ok = firstClaim && collisionRejected && wrongOwnerDidNotRelease && released
    && runningHeadlessRetained && settledHeadlessDisposed && visibleRetained && sidebarRetained
    && replacementNew && selectedSessionBecomesLive && ownSessionDoesNotDuplicate && idleSessionUsesExistingController
    && editorTabTitleIsCapped && shortTabTitleIsUntouched
    && visibleMoveLeavesFreshSource && backgroundMoveHasNoSource;
  return [{
    name: "chat surface coordination",
    ok,
    detail: ok
      ? "claims are exclusive; claimed sessions move to the requesting surface with a fresh visible source; background runs survive until settle"
      : "claim ownership, claimed-session transfer, tab-title cap or headless runtime lifecycle invariant failed",
  }];
}

export async function runSpikeDiagnostics(): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];

  results.push({
    name: "host runtime",
    ok: true,
    detail: `node ${process.versions.node}, electron ${process.versions.electron ?? "n/a"}, v8 ${process.versions.v8}`,
  });

  results.push({
    name: "sdk version",
    ok: true,
    detail: `${__PI_SDK_VERSION__} (bundled)`,
  });

  results.push(await checkUndici());
  results.push(await checkPackageAssets());
  results.push(await checkJiti());
  results.push(await checkClipboardNative());

  return results;
}

/** The bundle must contain exactly one undici, at >= 8.7.0 (proxy fix). */
async function checkUndici(): Promise<DiagnosticResult> {
  const version = __PI_UNDICI_VERSION__;
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  const ok = major > 8 || (major === 8 && minor >= 7);
  const proxyEnv = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]
    .map((key) => (process.env[key] ? `${key}=${process.env[key]}` : undefined))
    .filter(Boolean)
    .join(", ");
  try {
    const undici = await import("undici");
    const hasProxyAgent = typeof undici.ProxyAgent === "function";
    return {
      name: "undici alias",
      ok: ok && hasProxyAgent,
      detail: `bundled ${version}${hasProxyAgent ? "" : " (ProxyAgent missing!)"}; proxy env: ${proxyEnv || "(none)"}`,
    };
  } catch (error) {
    return { name: "undici alias", ok: false, detail: `import failed: ${describe(error)}` };
  }
}

/** Bundling can break path lookups that assume the SDK's on-disk layout. */
async function checkPackageAssets(): Promise<DiagnosticResult> {
  try {
    return {
      name: "sdk paths",
      ok: true,
      detail: `packageDir=${getPackageDir()}; agentDir=${getAgentDir()}`,
    };
  } catch (error) {
    return { name: "sdk paths", ok: false, detail: describe(error) };
  }
}

/** Extensions authored in TypeScript are loaded through jiti at runtime. */
async function checkJiti(): Promise<DiagnosticResult> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-jiti-"));
    const file = join(dir, "probe.ts");
    await writeFile(file, "const value: number = 42;\nexport default value;\n", "utf8");
    const { createJiti } = await import("jiti/static");
    // `__filename` exists because the extension bundle is emitted as CJS.
    const jiti = createJiti(__filename);
    const loaded = (await jiti.import(file, { default: true })) as number;
    return { name: "jiti .ts loading", ok: loaded === 42, detail: `loaded probe.ts -> ${String(loaded)}` };
  } catch (error) {
    return { name: "jiti .ts loading", ok: false, detail: describe(error) };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Optional native dependency used for image paste; must degrade gracefully. */
async function checkClipboardNative(): Promise<DiagnosticResult> {
  try {
    const mod = await import("@mariozechner/clipboard");
    return { name: "native clipboard (optional)", ok: true, detail: `loaded, exports: ${Object.keys(mod).join(", ") || "(none)"}` };
  } catch (error) {
    return { name: "native clipboard (optional)", ok: false, detail: `not loadable (image paste disabled): ${describe(error)}` };
  }
}

export function formatDiagnostics(results: DiagnosticResult[]): string {
  const lines = ["# Pi Agent Chat - Spike Diagnostics", ""];
  for (const result of results) {
    lines.push(`${result.ok ? "[ok]  " : "[fail]"} ${result.name}: ${result.detail}`);
  }
  return lines.join("\n");
}

/**
 * Offline check (no LLM call): resume the most recent session for `cwd` and
 * verify the persisted transcript maps to renderable chat events.
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
 * Offline check (no LLM call): resuming a turn that automatic retry gave up on.
 *
 * Two things are pinned. The SDK entry point the resume rides on is private
 * (`agent/resume.ts` explains why nothing public does the job), so a rename
 * upstream must show up here rather than as a button that quietly stops
 * working. And the resume itself must stay non-destructive: it drops the
 * failed response and *only* that, and re-issues the request with an empty
 * message batch — inventing a "continue" message is exactly what it exists to
 * avoid. The run itself is stubbed out; making a real request is the live
 * test's job.
 */
export async function runManualRetryTest(cwd: string): Promise<DiagnosticResult[]> {
  type StoredMessage = Parameters<SessionManager["appendMessage"]>[0];
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

    // A turn that ended normally is not a retry candidate: re-running it would
    // throw away the answer on screen.
    const succeeded = await open([user("first"), assistant("stop")]);
    sessions.push(succeeded);
    const afterSuccess = isResumable(succeeded);

    // Regression: error -> user -> error must still offer retry even if Pi's
    // automatic retry already removed the last error from agent state. The
    // active SessionManager branch is what the transcript shows and therefore
    // the source of truth for whether the turn is interrupted.
    const repeated = await open([user("first"), assistant("error"), user("second"), assistant("error")]);
    sessions.push(repeated);
    repeated.agent.state.messages = repeated.agent.state.messages.slice(0, -1);
    const afterRepeatedFailure = isResumable(repeated);

    // A prompt that throws before producing any assistant message leaves the
    // user at the branch tail; the host error card still represents a request
    // that can be re-issued through the same empty-batch path.
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
 * Offline check (no LLM call): reopening a session that died mid-request must
 * still offer the retry.
 *
 * The live offer is a transcript event, so it exists only in the window that
 * watched the run fail. A window opening the same session later replays it from
 * the file, where the failure is just a provider error ("Request timed out.")
 * with nothing to click — which is exactly what this covers: the whole path,
 * from a session file that ends on a failed response through `PiRuntime` and a
 * real `ChatBridge.attach()`, down to the `history` message actually posted.
 */
export async function runReplayedRetryOfferTest(cwd: string): Promise<DiagnosticResult[]> {
  type StoredMessage = Parameters<SessionManager["appendMessage"]>[0];
  let dir: string | undefined;
  let runtime: PiRuntime | undefined;
  try {
    // A throwaway session directory: this transcript must not show up in the
    // user's own session list.
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-retry-replay-"));
    const manager = SessionManager.create(cwd, dir);
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as StoredMessage);
    manager.appendMessage({
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "probe-provider",
      model: "probe-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "Request timed out.",
      timestamp: Date.now(),
    } as StoredMessage);
    const file = manager.getSessionFile();
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
    // The provider error itself must survive too: the offer explains what to do
    // next, not what went wrong.
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
 * Offline check (no LLM call): the retry offer must resolve on the transcript.
 *
 * The button is drawn from the state the host puts on the notice, so the whole
 * lifecycle is host-side and invisible to the webview smoke test. It pins the
 * reported multi-request case: a retry gets a successful tool-request response,
 * then its next provider request times out. The clicked offer must resolve as
 * succeeded, while the later timeout gets a separate offer. Retrying that new
 * failure without any successful response must resolve only the new offer as
 * failed. The states must also survive a transcript replay instead of living
 * only in the clicked button. Requests are stubbed; a real one is the live
 * test's job.
 */
export async function runRetryOfferLifecycleTest(cwd: string): Promise<DiagnosticResult[]> {
  type StoredMessage = Parameters<SessionManager["appendMessage"]>[0];
  type Runner = { _runAgentPrompt: (messages: unknown[]) => Promise<void> };
  const name = "retry offer lifecycle";
  let dir: string | undefined;
  let runtime: PiRuntime | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-retry-lifecycle-"));
    const manager = SessionManager.create(cwd, dir);
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as StoredMessage);
    manager.appendMessage({
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "probe-provider",
      model: "probe-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "Request timed out.",
      timestamp: Date.now(),
    } as StoredMessage);
    const file = manager.getSessionFile();
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
    const response = (stopReason: "toolUse" | "error", text: string): StoredMessage => ({
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

    // Retry A receives a valid tool-request response, then the provider call
    // after that tool activity times out. A succeeded; the timeout owns offer B.
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

    // Replaying must retain A's spent state and independently recreate B.
    posted.length = 0;
    await bridge.attach();
    const afterReplay = latestRetryStates(posted);

    // Retry B never receives a successful response. B fails and the new
    // interruption owns offer C; A must not be rewritten by B's outcome.
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
    bridge.dispose();

    const expectedFirst = afterPartialSuccess.join(",") === "succeeded,offered";
    const expectedReplay = afterReplay.join(",") === "succeeded,offered";
    const expectedSecond = afterFailedRetry.join(",") === "succeeded,failed,offered";
    const ok = duringRun && expectedFirst && expectedReplay && expectedSecond;
    return [{
      name,
      ok,
      detail: `while running=${duringRun ? "running" : "NOT MARKED"}; after tool success + later timeout=${afterPartialSuccess.join(",") || "nothing"}; after replay=${afterReplay.join(",") || "nothing"}; after retry without success=${afterFailedRetry.join(",") || "nothing"}`,
    }];
  } catch (error) {
    return [{ name, ok: false, detail: describe(error) }];
  } finally {
    runtime?.dispose();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Retry states carried by every transcript the host posted, in order. */
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

/**
 * Offline check (no LLM call): the `/` autocomplete catalogue must contain the
 * built-ins plus everything the CLI would offer (prompts, extension commands,
 * skills).
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
 * Offline check (no LLM call): the session tree of the most recent session must
 * flatten into selectable entries, which is what `/tree` and `/fork` show.
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

/** Offline check: project file discovery, filtering and path validation for the @ picker. */
export async function runProjectFilesTest(cwd: string): Promise<DiagnosticResult[]> {
  try {
    const index = new ProjectFileIndex(() => {});
    const items = await index.search(cwd, "", false);
    const hasFiles = items.length > 0;

    // Path safety: escaping / absolute paths must be rejected.
    let escapeRejected = false;
    try {
      await index.validate(cwd, ["../outside.txt"]);
    } catch {
      escapeRejected = true;
    }

    // A known real file must validate cleanly.
    const sample = items[0]?.path;
    const validated = sample ? await index.validate(cwd, [sample]) : { paths: [] };
    const sampleOk = !sample || validated.paths.length === 1;

    return [{
      name: "project files",
      ok: hasFiles && escapeRejected && sampleOk,
      detail: `indexed=${items.length}, escapeRejected=${escapeRejected}, sample=${sample ?? "n/a"}`,
    }];
  } catch (error) {
    return [{ name: "project files", ok: false, detail: describe(error) }];
  }
}

/**
 * Offline check on the one tool this extension adds to pi's own set: when
 * enabled it must be registered and active without any explicit activation
 * call, it must not leak into a child session, and it must not displace pi's
 * core tools. When disabled it must be absent entirely.
 */
export async function runSubagentToolTest(cwd: string): Promise<DiagnosticResult[]> {
  const coordinator = new SubagentCoordinator(() => {});
  const tool = coordinator.createTool({ enabled: true, maxSubagents: 3 });
  try {
    // What this window activates *without* the host tool, which is the only
    // honest baseline: which of pi's tools are on is the user's decision
    // (`defaultTools` in the shared settings, extensions that re-activate
    // more), so naming them here would report a red for a configuration
    // choice rather than for a defect — and a self-check that is red by
    // default is one nobody reads.
    const baselineResult = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(cwd),
    });
    const baselineActive = new Set(baselineResult.session.getActiveToolNames());
    baselineResult.session.dispose();

    const parentResult = await createAgentSession({
      cwd,
      customTools: [tool],
      // Mirror the real assembly in `runtime.ts`: when enabled there is no
      // exclusion — the SDK's tool registry makes the custom tool override an
      // extension tool of the same name (`core/agent-session.ts`,
      // `_refreshToolRegistry()`).
      sessionManager: SessionManager.inMemory(cwd),
    });
    const parentActive = new Set(parentResult.session.getActiveToolNames());
    parentResult.session.dispose();

    // A child gets scoped file tools instead of the built-in ones, and can
    // never reach the delegation tool itself.
    const childResult = await createAgentSession({
      cwd,
      customTools: [tool],
      excludeTools: [SUBAGENT_TOOL],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const childHasTool = childResult.session.agent.state.tools.some((entry) => entry.name === SUBAGENT_TOOL);
    childResult.session.dispose();

    // Disabled is the default, and must mean the name is simply not there:
    // excluded, since there is no host tool to take the name over.
    const offResult = await createAgentSession({
      cwd,
      customTools: [],
      excludeTools: [SUBAGENT_TOOL],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const offActive = new Set(offResult.session.getActiveToolNames());
    offResult.session.dispose();
    await coordinator.dispose();

    // Adding a custom tool must displace nothing that was active without it.
    const displaced = [...baselineActive].filter((name) => !parentActive.has(name));
    return [{
      name: "subagent tool",
      ok:
        parentActive.has(SUBAGENT_TOOL) &&
        !childHasTool &&
        !offActive.has(SUBAGENT_TOOL) &&
        displaced.length === 0,
      detail: `active: ${[...parentActive].sort().join(", ") || "(none)"}; child=${childHasTool ? "unexpectedly enabled" : "excluded"}; disabled=${offActive.has(SUBAGENT_TOOL) ? "still present" : "absent"}; displaced=${displaced.join(", ") || "(none)"}`,
    }, ...(await checkSubagentShadow(cwd, tool)), ...(await checkScopeEnforcement(cwd)), checkSubagentModelSelection(), ...(await checkSubagentIsolation(cwd))];
  } catch (error) {
    await coordinator.dispose();
    return [{ name: "subagent tool", ok: false, detail: describe(error) }];
  }
}

/** A pi extension that claims the `subagent` tool name, written to a temp dir. */
const SUBAGENT_PROBE_EXTENSION = `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "diagnostic probe",
    parameters: Type.Object({ task: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: "probe" }], details: {} }),
  });
}
`;

/**
 * An extension's `subagent` tool must never reach the model in this host.
 *
 * The plugin owns the name, in both switch states: when the host tool is
 * disabled the name is excluded, and when it is enabled the SDK's tool
 * registry makes the custom tool override an extension tool of the same name
 * (`core/agent-session.ts`, `_refreshToolRegistry()`), so the model always
 * resolves `subagent` to the host's tool or to nothing — never to the
 * extension's.
 *
 * Pins the halves: the suppressed extension is still identifiable so the
 * new-session notice can name it, the disabled state really has no `subagent`
 * at all, the enabled state resolves the name to the *host's* tool (checked
 * by description, not by name alone), and the override survives a reload.
 * Also pins the timing detection relies on — extension tool names are
 * readable straight after `createAgentSessionServices()`.
 */
async function checkSubagentShadow(cwd: string, tool: ToolDefinition): Promise<DiagnosticResult[]> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-subagent-ext-"));
    await writeFile(join(dir, "index.ts"), SUBAGENT_PROBE_EXTENSION, "utf8");
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { additionalExtensionPaths: [dir] },
    });
    const shadowed = findShadowedExtensionTool(services, SUBAGENT_TOOL);

    // Disabled half: exactly what `PiRuntime.create()` does — exclude the name.
    const off = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      excludeTools: [SUBAGENT_TOOL],
    });
    const offClean = !off.session.getActiveToolNames().includes(SUBAGENT_TOOL);
    off.session.dispose();

    // Enabled half: no exclusion; the host tool must win the name.
    const on = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      customTools: [tool],
    });
    const onOurs = isHostSubagentTool(on.session);
    // The override must survive a reload: reload() rebuilds the registry from
    // the session's persistent exclusion set and custom tools, and re-activates
    // every extension tool (`includeAllExtensionTools`), so a name that is not
    // actually overridden would resurface right here.
    await on.session.reload();
    const reloadOurs = isHostSubagentTool(on.session);
    on.session.dispose();

    return [{
      name: "subagent shadowing",
      ok: shadowed === dir && offClean && onOurs && reloadOurs,
      detail:
        `detected=${shadowed ?? "(none)"}; off=${offClean ? "absent" : "LEAKED"}; ` +
        `on=${onOurs ? "host tool wins" : "EXTENSION TOOL EXPOSED"}; ` +
        `after reload=${reloadOurs ? "host tool wins" : "EXTENSION TOOL EXPOSED"}`,
    }];
  } catch (error) {
    return [{ name: "subagent shadowing", ok: false, detail: describe(error) }];
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The `subagent` tool this session resolves must be the host's, not the extension's. */
function isHostSubagentTool(session: AgentSession): boolean {
  const info = session.getAllTools().find((entry) => entry.name === SUBAGENT_TOOL);
  // The host tool's description names isolated subagents; the probe's does not.
  return info?.description?.includes("isolated subagents") ?? false;
}

/**
 * A subagent's writes must be refused outside its declared range.
 *
 * This is the guarantee the whole feature rests on: children write to the real
 * working tree and nothing is rolled back, so a range that is merely advisory
 * would make the design indefensible. Exercises the actual enforcement path —
 * the SDK's own `edit`/`write` definitions built with a replacement file
 * operation layer — rather than the checker in isolation.
 */
async function checkScopeEnforcement(cwd: string): Promise<DiagnosticResult[]> {
  try {
    const guard = new ScopeGuard(cwd, normalizeScopes(cwd, ["src"]));
    const names = createScopedFileTools(cwd, guard).map((tool) => tool.name).sort();

    let refused = false;
    try {
      guard.assertWritable(join(cwd, "package.json"));
    } catch {
      refused = true;
    }
    let allowed = true;
    try {
      guard.recordWrite(join(cwd, "src", "probe.ts"));
    } catch {
      allowed = false;
    }
    // Two ranges where one contains the other could target the same file, so
    // the call must be rejected before any child starts.
    const conflict = findScopeConflict([normalizeScopes(cwd, ["src"]), normalizeScopes(cwd, ["src/agent"])]);
    const disjoint = findScopeConflict([normalizeScopes(cwd, ["src/agent"]), normalizeScopes(cwd, ["src/webview"])]);

    return [{
      name: "subagent scope enforcement",
      ok:
        names.join(",") === "edit,write" &&
        refused &&
        allowed &&
        Boolean(conflict) &&
        !disjoint &&
        guard.writtenFiles.join(",") === "src/probe.ts" &&
        guard.violationCount === 1 &&
        // The refused path itself must survive to the report: a bare count
        // leaves the parent unable to finish what the child could not.
        guard.deniedPaths.join(",") === "package.json",
      detail: `tools=${names.join(",")}; out-of-range=${refused ? "refused" : "ALLOWED"}; in-range=${allowed ? "allowed" : "REFUSED"}; denied=${guard.deniedPaths.join(",") || "NONE"}; overlap=${conflict ? "rejected" : "MISSED"}; disjoint=${disjoint ? "WRONGLY REJECTED" : "accepted"}`,
    }];
  } catch (error) {
    return [{ name: "subagent scope enforcement", ok: false, detail: describe(error) }];
  }
}

/**
 * Where a subagent's model comes from, and who is told when one is missing.
 *
 * A model the parent agent named itself is a mechanical argument error: the
 * call must be rejected before any child starts, so it can correct it. A model
 * the *user* configured — the subagent default model setting — must
 * step down to the next source instead and produce a user-facing notice only:
 * failing the lane would throw away a whole task over a typo, and reporting it
 * to the parent would describe a choice it never made.
 */
function checkSubagentModelSelection(): DiagnosticResult {
  type Options = Parameters<typeof planModel>[0];
  try {
    const known = [{ provider: "acme", id: "fast" }, { provider: "acme", id: "slow" }];
    const modelRuntime = {
      getModel: (provider: string, id: string) => known.find((model) => model.provider === provider && model.id === id),
      getModels: () => known,
    } as unknown as Options["modelRuntime"];
    const parentModel = known[1] as Options["parentModel"];
    const base = { modelRuntime, parentModel, index: 0 };
    const enabled = { enabled: true, maxSubagents: 3 };

    let requestedRejected = false;
    try {
      planModel({ ...base, requested: "acme/missing", config: enabled });
    } catch {
      requestedRejected = true;
    }

    // The setting resolves: the lane runs on it, silently.
    const settingOk = planModel({ ...base, config: { ...enabled, defaultModel: "acme/fast" } });
    // The setting misses: the lane inherits the parent's model and the user
    // (not the parent agent) is told.
    const settingMiss = planModel({ ...base, config: { ...enabled, defaultModel: "acme/gone" } });
    // Nothing configured: the parent's model, no notice.
    const inherited = planModel({ ...base, config: enabled });

    const ok =
      requestedRejected &&
      settingOk.model?.id === "fast" &&
      settingOk.notices.length === 0 &&
      settingMiss.model?.id === "slow" &&
      settingMiss.notices.length === 1 &&
      settingMiss.notices[0]?.source === "setting" &&
      settingMiss.notices[0]?.using === "acme/slow" &&
      inherited.model?.id === "slow" &&
      inherited.notices.length === 0;
    return {
      name: "subagent model selection",
      ok,
      detail:
        `requested-miss=${requestedRejected ? "rejected" : "ACCEPTED"}; ` +
        `setting-ok=${settingOk.model?.id ?? "none"}/${settingOk.notices.length} notice(s); ` +
        `setting-miss=${settingMiss.model?.id ?? "none"}/${settingMiss.notices.length} notice(s); ` +
        `inherited=${inherited.model?.id ?? "none"}/${inherited.notices.length} notice(s)`,
    };
  } catch (error) {
    return { name: "subagent model selection", ok: false, detail: describe(error) };
  }
}

/** A pi extension whose tool reads session state through the shared `pi` API. */
const SESSION_NAME_PROBE_EXTENSION = `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "session_name_probe",
    label: "Session name probe",
    description: "diagnostic probe",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: pi.getSessionName() ?? "(unnamed)" }],
      details: {},
    }),
  });
}
`;

/**
 * A finished subagent must leave the parent's extensions alone.
 *
 * Extensions are loaded per resource loader and every session built from that
 * loader shares the resulting extension runtime, so a child session created
 * from the parent's services would retarget every `pi.*` action at itself and
 * then mark the shared runtime stale on `dispose()`. This runs the coordinator's
 * exact service construction (`createSubagentServices()`), disposes the child,
 * and calls back into the parent's extension API: it must still answer, and it
 * must answer with the *parent's* session name.
 */
async function checkSubagentIsolation(cwd: string): Promise<DiagnosticResult[]> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-subagent-iso-"));
    await writeFile(join(dir, "index.ts"), SESSION_NAME_PROBE_EXTENSION, "utf8");
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { additionalExtensionPaths: [dir] },
    });
    const { session: parent } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
    });
    parent.setSessionName("parent");

    const childServices = await createSubagentServices(services);
    const { session: child } = await createAgentSessionFromServices({
      services: childServices,
      sessionManager: SessionManager.inMemory(cwd),
      excludeTools: ["subagent"],
    });
    child.setSessionName("child");
    child.dispose();

    // The wrapped agent tool, not `getToolDefinition()`: the latter hands back
    // the raw extension definition, which still expects an ExtensionContext.
    const probe = parent.agent.state.tools.find((tool) => tool.name === "session_name_probe");
    let answer: string;
    try {
      const result = await probe?.execute("probe", {}, undefined, undefined);
      const block = result?.content.find((entry) => entry.type === "text");
      answer = block && "text" in block ? block.text : "(no probe tool)";
    } catch (error) {
      answer = `threw: ${describe(error)}`;
    }
    parent.dispose();
    return [{
      name: "subagent isolation",
      ok: answer === "parent",
      detail: `parent extension API after child dispose: ${answer}`,
    }];
  } catch (error) {
    return [{ name: "subagent isolation", ok: false, detail: describe(error) }];
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* -- vscode_terminal ----------------------------------------------------- */

/** A pi extension that claims the `vscode_terminal` tool name. */
const TERMINAL_PROBE_EXTENSION = `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "vscode_terminal",
    label: "VS Code terminal",
    description: "diagnostic probe",
    parameters: Type.Object({ command: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: "probe" }], details: {} }),
  });
}
`;

/**
 * Offline checks on the terminal tool.
 *
 * Everything here runs against a scripted terminal API rather than a real
 * window, which is the only way to pin the two behaviours that matter most and
 * are invisible in normal use: a missing shell integration must *refuse*
 * rather than report an empty success, and `close` must be unable to touch a
 * terminal this tool did not create.
 */
export async function runTerminalToolTest(cwd: string): Promise<DiagnosticResult[]> {
  const pool = new VsCodeTerminalPool(() => cwd, () => {}, new ScriptedTerminalApi(), FAST_TIMEOUTS);
  const tool = pool.createTool({ enabled: true, maxTerminals: 3 });
  try {
    const baseline = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd) });
    const baselineActive = new Set(baseline.session.getActiveToolNames());
    baseline.session.dispose();

    const on = await createAgentSession({
      cwd,
      customTools: [tool],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const onActive = new Set(on.session.getActiveToolNames());
    on.session.dispose();

    // Disabled is the default, and must mean the name is simply not there.
    const off = await createAgentSession({
      cwd,
      customTools: [],
      excludeTools: [VSCODE_TERMINAL_TOOL],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const offActive = new Set(off.session.getActiveToolNames());
    off.session.dispose();

    const displaced = [...baselineActive].filter((name) => !onActive.has(name));
    const results: DiagnosticResult[] = [{
      name: "terminal tool",
      ok: onActive.has(VSCODE_TERMINAL_TOOL) && !offActive.has(VSCODE_TERMINAL_TOOL) && displaced.length === 0,
      detail:
        `enabled=${onActive.has(VSCODE_TERMINAL_TOOL) ? "active" : "MISSING"}; ` +
        `disabled=${offActive.has(VSCODE_TERMINAL_TOOL) ? "still present" : "absent"}; ` +
        `displaced=${displaced.join(", ") || "(none)"}`,
    }];
    results.push(...(await checkTerminalShadow(cwd, tool)));
    results.push(...(await checkTerminalBehaviour(cwd)));
    return results;
  } catch (error) {
    return [{ name: "terminal tool", ok: false, detail: describe(error) }];
  } finally {
    pool.dispose();
  }
}

/**
 * An extension's `vscode_terminal` must never reach the model here — same rule
 * and same mechanism as `subagent`, checked the same way: the name belongs to
 * this window's tool, whether that tool is switched on (registry override) or
 * off (excluded outright).
 */
async function checkTerminalShadow(cwd: string, tool: ToolDefinition): Promise<DiagnosticResult[]> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-terminal-ext-"));
    await writeFile(join(dir, "index.ts"), TERMINAL_PROBE_EXTENSION, "utf8");
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { additionalExtensionPaths: [dir] },
    });
    const shadowed = findShadowedExtensionTool(services, VSCODE_TERMINAL_TOOL);

    const off = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      excludeTools: [VSCODE_TERMINAL_TOOL],
    });
    const offClean = !off.session.getActiveToolNames().includes(VSCODE_TERMINAL_TOOL);
    off.session.dispose();

    const on = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      customTools: [tool],
    });
    const onOurs = isHostTerminalTool(on.session);
    await on.session.reload();
    const reloadOurs = isHostTerminalTool(on.session);
    on.session.dispose();

    return [{
      name: "terminal tool shadowing",
      ok: shadowed === dir && offClean && onOurs && reloadOurs,
      detail:
        `detected=${shadowed ?? "(none)"}; off=${offClean ? "absent" : "LEAKED"}; ` +
        `on=${onOurs ? "host tool wins" : "EXTENSION TOOL EXPOSED"}; ` +
        `after reload=${reloadOurs ? "host tool wins" : "EXTENSION TOOL EXPOSED"}`,
    }];
  } catch (error) {
    return [{ name: "terminal tool shadowing", ok: false, detail: describe(error) }];
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function isHostTerminalTool(session: AgentSession): boolean {
  const info = session.getAllTools().find((entry) => entry.name === VSCODE_TERMINAL_TOOL);
  // The host tool's description explains the visible terminal; the probe's does not.
  return info?.description?.includes("stays visible to the user") ?? false;
}

/**
 * The behaviour a real terminal cannot be asked to demonstrate on demand.
 *
 * 1. **No shell integration means no command.** Running blind would return an
 *    empty success, which is exactly the failure mode this host shadows
 *    extension `subagent`s for, and the terminal created for the attempt must
 *    not be left behind.
 * 2. **A command that outruns its timeout is not killed**, and the result says
 *    so, because it may be waiting for the user to type.
 * 3. **`read` returns only what is new**, so a progress bar redrawing one line
 *    cannot re-send the whole screen.
 * 4. **`close` only touches terminals this tool created.** A terminal opened by
 *    the user or by another extension must survive whatever id is passed.
 */
async function checkTerminalBehaviour(cwd: string): Promise<DiagnosticResult[]> {
  const failures: string[] = [];
  const notes: string[] = [];

  // 1. No shell integration.
  {
    const api = new ScriptedTerminalApi({ shellIntegration: false });
    const pool = new VsCodeTerminalPool(() => cwd, () => {}, api, FAST_TIMEOUTS);
    let refused = false;
    try {
      await pool.execute({ action: "run", command: "echo hi" }, { enabled: true, maxTerminals: 3 });
    } catch {
      refused = true;
    }
    if (!refused) failures.push("a command ran (or reported success) without shell integration");
    if (api.terminals.some((terminal) => !terminal.disposed)) {
      failures.push("the terminal created for a refused command was left open");
    }
    notes.push(`no integration: ${refused ? "refused" : "RAN ANYWAY"}`);
    pool.dispose();
  }

  // 2 & 3. A command that does not finish, then an incremental read.
  {
    const api = new ScriptedTerminalApi({ script: { chunks: ["one\r\n", "two\r\n"], end: false } });
    const pool = new VsCodeTerminalPool(() => cwd, () => {}, api, FAST_TIMEOUTS);
    const config = { enabled: true, maxTerminals: 3 };
    const run = await pool.execute({ action: "run", command: "npm install", timeoutSeconds: 1 }, config);
    const stillRunning = run.text.includes("STILL RUNNING") && run.text.includes("one");
    if (!stillRunning) failures.push(`an unfinished command was not reported as running: ${oneLine(run.text)}`);
    if (api.terminals.some((terminal) => terminal.disposed)) {
      failures.push("a command that timed out had its terminal disposed");
    }
    // Nothing new, then one more line: a read must report only the new one.
    const idle = await pool.execute({ action: "read", terminal: "1" }, config);
    api.push("three\r\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await pool.execute({ action: "read", terminal: "1" }, config);
    if (idle.text.includes("one")) failures.push("a second read repeated output already delivered");
    if (!after.text.includes("three") || after.text.includes("one")) {
      failures.push(`an incremental read did not return exactly the new output: ${oneLine(after.text)}`);
    }
    notes.push(`unfinished: ${stillRunning ? "reported running" : "MISREPORTED"}`);
    pool.dispose();
  }

  // 4. Closing.
  {
    const api = new ScriptedTerminalApi({ script: { chunks: ["done\r\n"], end: true, exitCode: 0 } });
    const pool = new VsCodeTerminalPool(() => cwd, () => {}, api, FAST_TIMEOUTS);
    const config = { enabled: true, maxTerminals: 3 };
    const foreign = api.openForeignTerminal();
    const finished = await pool.execute({ action: "run", command: "echo done" }, config);
    if (!finished.text.includes("done") || !finished.text.includes("succeeded")) {
      failures.push(`a finished command did not report its output and status: ${oneLine(finished.text)}`);
    }
    let refusedForeign = false;
    try {
      await pool.execute({ action: "close", terminal: "999" }, config);
    } catch {
      refusedForeign = true;
    }
    if (!refusedForeign) failures.push("close accepted a terminal id this tool never created");
    if (foreign.disposed) failures.push("close disposed a terminal that belongs to somebody else");
    await pool.execute({ action: "close", terminal: "1" }, config);
    const own = api.terminals.find((terminal) => terminal !== foreign);
    if (!own?.disposed) failures.push("close did not dispose the tool's own terminal");
    notes.push(`close: foreign ${refusedForeign ? "refused" : "ACCEPTED"}, own ${own?.disposed ? "disposed" : "KEPT"}`);
    pool.dispose();
  }

  return [{
    name: "terminal tool behaviour",
    ok: failures.length === 0,
    detail: failures.length === 0 ? notes.join("; ") : failures.join("; "),
  }];
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 160);
}

/** Short waits: no real shell is involved, so nothing here needs seconds. */
const FAST_TIMEOUTS: TerminalTimeouts = { shellIntegrationMs: 50, shellTypeMs: 50 };

/** What one scripted command produces. */
interface TerminalScript {
  chunks: string[];
  /** Whether the execution ends by itself (a command that finishes). */
  end: boolean;
  exitCode?: number;
}

class ScriptedTerminal implements TerminalLike {
  disposed = false;
  shellIntegration?: ShellIntegrationLike;
  constructor(
    readonly name: string,
    readonly state: { shell?: string },
    private readonly onDispose: (terminal: ScriptedTerminal) => void,
  ) {}
  show(): void {}
  dispose(): void {
    this.disposed = true;
    this.onDispose(this);
  }
}

/**
 * A terminal API that answers from a script instead of a shell.
 *
 * Deliberately minimal: it exists to reach the refusal and timeout paths,
 * which a real terminal would only reach by luck.
 */
class ScriptedTerminalApi implements TerminalApi {
  readonly terminals: ScriptedTerminal[] = [];
  private readonly closeListeners: ((terminal: TerminalLike) => void)[] = [];
  private readonly endListeners: ((event: { terminal: TerminalLike; execution: ExecutionLike; exitCode: number | undefined }) => void)[] = [];
  private current?: { terminal: ScriptedTerminal; execution: ExecutionLike; push: (chunk: string) => void; close: () => void };

  constructor(private readonly options: { shellIntegration?: boolean; script?: TerminalScript } = {}) {}

  /** Feed one more chunk into the running execution. */
  push(chunk: string): void {
    this.current?.push(chunk);
  }

  /** A terminal this pool did not create, as the user or another extension would. */
  openForeignTerminal(): ScriptedTerminal {
    const terminal = new ScriptedTerminal("foreign", { shell: "bash" }, () => {});
    this.terminals.push(terminal);
    return terminal;
  }

  createTerminal(options: { name: string; cwd: string }): TerminalLike {
    const terminal = new ScriptedTerminal(options.name, { shell: "bash" }, (closed) => {
      for (const listener of this.closeListeners) listener(closed);
    });
    if (this.options.shellIntegration !== false) {
      terminal.shellIntegration = { executeCommand: () => this.startExecution(terminal) };
    }
    this.terminals.push(terminal);
    return terminal;
  }

  private startExecution(terminal: ScriptedTerminal): ExecutionLike {
    const script = this.options.script ?? { chunks: [], end: true, exitCode: 0 };
    const queue: string[] = [...script.chunks];
    let notify: (() => void) | undefined;
    let closed = false;
    const execution: ExecutionLike = {
      read: async function* read() {
        while (true) {
          while (queue.length > 0) yield queue.shift() as string;
          if (closed) return;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      },
    };
    const push = (chunk: string) => {
      queue.push(chunk);
      notify?.();
      notify = undefined;
    };
    const close = () => {
      closed = true;
      notify?.();
      notify = undefined;
    };
    this.current = { terminal, execution, push, close };
    if (script.end) {
      setTimeout(() => {
        close();
        for (const listener of this.endListeners) listener({ terminal, execution, exitCode: script.exitCode });
      }, 5);
    }
    return execution;
  }

  onDidChangeTerminalShellIntegration(): DisposableLike {
    // Scripted terminals arrive with their integration already attached, so
    // nothing ever fires here; the absent case simply never resolves.
    return { dispose() {} };
  }

  onDidEndTerminalShellExecution(
    listener: (event: { terminal: TerminalLike; execution: ExecutionLike; exitCode: number | undefined }) => void,
  ): DisposableLike {
    this.endListeners.push(listener);
    return { dispose: () => this.endListeners.splice(this.endListeners.indexOf(listener), 1) };
  }

  onDidCloseTerminal(listener: (terminal: TerminalLike) => void): DisposableLike {
    this.closeListeners.push(listener);
    return { dispose: () => this.closeListeners.splice(this.closeListeners.indexOf(listener), 1) };
  }

  onDidChangeTerminalState(): DisposableLike {
    return { dispose() {} };
  }
}

/** A pi extension that imports the SDK the way real extensions do. */
const SDK_IMPORT_PROBE_EXTENSION = `import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "sdk_import_probe",
    label: "SDK import probe",
    description: String(typeof getAgentDir),
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "probe" }], details: {} }),
  });
}
`;

/**
 * An extension must be able to `import "@earendil-works/pi-coding-agent"`.
 *
 * Only meaningful inside the bundle. Extensions are loaded by jiti against the
 * SDK *on disk*, using aliases the SDK derives from `import.meta.url` — which
 * bundling to CJS erases and `esbuild.mjs` has to reconstruct. Get that wrong
 * and the alias points at a path that does not exist, so every extension
 * importing the SDK fails to load while everything else keeps working.
 *
 * Two ways this has already broken: the alias landing two directories too high
 * (fixed by `sdkModuleUrlPlugin`), and the on-disk SDK missing its own
 * dependencies (`scripts/check_extension_runtime.mjs`).
 */
export async function runExtensionSdkImportTest(cwd: string): Promise<DiagnosticResult[]> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-sdk-import-"));
    const probeDir = dir;
    await writeFile(join(probeDir, "index.ts"), SDK_IMPORT_PROBE_EXTENSION, "utf8");
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { additionalExtensionPaths: [probeDir] },
    });
    const { extensions, errors } = services.resourceLoader.getExtensions();
    const probe = extensions.find((extension) => extension.path.startsWith(probeDir));
    const failure = errors.find((error) => String((error as { path?: string }).path ?? "").startsWith(probeDir));
    return [{
      name: "extension sdk import",
      ok: probe !== undefined && failure === undefined,
      detail: failure
        ? `probe extension failed to load: ${String((failure as { error?: unknown }).error ?? failure)}`
        : `probe extension loaded, tools: ${probe ? [...probe.tools.keys()].join(", ") || "(none)" : "(not found)"}`,
    }];
  } catch (error) {
    return [{ name: "extension sdk import", ok: false, detail: describe(error) }];
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** One pi extension in two versions, to prove a reload swaps the instances. */
const reloadProbeExtension = (toolName: string) => `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "${toolName}",
    label: "Reload probe",
    description: "diagnostic probe",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "probe" }], details: {} }),
  });
}
`;

/**
 * Reloading resources must rebuild the session's extension runner.
 *
 * A session builds its `ExtensionRunner` once, from the loader's cached
 * `getExtensions()`, so reloading the resource loader alone leaves the session
 * on the *old* extension instances while the reloaded set sits unused — and a
 * `bindExtensions()` after it only re-fires `session_start` into those old
 * instances. `AgentSession.reload()` is the SDK-wide answer (all three modes
 * call it). This rewrites a probe extension between the two reads: the new
 * tool must appear, the old one must be gone, and neither the host's
 * `customTools` nor pi's core tools may fall out of the rebuilt registry.
 */
export async function runExtensionReloadTest(cwd: string): Promise<DiagnosticResult[]> {
  const coordinator = new SubagentCoordinator(() => {});
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-reload-"));
    const entry = join(dir, "index.ts");
    await writeFile(entry, reloadProbeExtension("reload_probe_before"), "utf8");
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { additionalExtensionPaths: [dir] },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      customTools: [coordinator.createTool({ enabled: true, maxSubagents: 3 })],
    });
    // Bindings of the same shape the sidebar attaches: without any, reload()
    // skips session_start and the probe would prove less than it looks.
    await session.bindExtensions({ mode: "rpc", onError: () => {} });
    const before = session.agent.state.tools.map((tool) => tool.name);

    await writeFile(entry, reloadProbeExtension("reload_probe_after"), "utf8");
    await session.reload();
    const after = session.agent.state.tools.map((tool) => tool.name);
    session.dispose();
    await coordinator.dispose();

    // Everything that was there before the reload, except the probe that was
    // deliberately rewritten away. Naming pi's tools here instead would make
    // this check red for anyone whose `defaultTools` differs from the default
    // set — a configuration choice, not a defect.
    const dropped = before.filter((name) => name !== "reload_probe_before" && !after.includes(name));
    const ok = before.includes("reload_probe_before") &&
      after.includes("reload_probe_after") &&
      !after.includes("reload_probe_before") &&
      dropped.length === 0;
    return [{
      name: "extension reload",
      ok,
      detail: `loaded=${before.includes("reload_probe_before")}; after reload: new=${after.includes("reload_probe_after")}, stale=${after.includes("reload_probe_before")}, dropped=${dropped.join(", ") || "(none)"}`,
    }];
  } catch (error) {
    await coordinator.dispose();
    return [{ name: "extension reload", ok: false, detail: describe(error) }];
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Extension *command* handlers must be able to drive the session.
 *
 * `ctx.newSession()` / `ctx.fork()` / `ctx.switchSession()` /
 * `ctx.navigateTree()` / `ctx.reload()` are backed by host-supplied actions
 * (`bindExtensions({ commandContextActions })`); without them the SDK falls
 * back to no-op stubs that report success, so an extension command would
 * appear to work and change nothing. This drives a real command context the
 * way an extension would: the session must actually be replaced, and the
 * sidebar must be told to re-attach (only the rebind hook can tell it — the
 * replacement happened inside the SDK).
 */
export async function runExtensionCommandContextTest(cwd: string): Promise<DiagnosticResult[]> {
  let runtime: PiRuntime | undefined;
  try {
    runtime = await PiRuntime.create({ cwd, log: () => {} });
    let reattached = 0;
    runtime.setSessionLifecycleSink({
      reattach: async () => {
        reattached += 1;
      },
      reload: async () => {},
    });
    await runtime.bindExtensions();

    const before = runtime.session.sessionId;
    const context = runtime.session.extensionRunner.createCommandContext();
    const result = await context.newSession();
    const replaced = !result.cancelled && runtime.session.sessionId !== before;
    return [{
      name: "extension command context",
      ok: replaced && reattached === 1,
      detail: `ctx.newSession(): replaced=${replaced}, reattach calls=${reattached}`,
    }];
  } catch (error) {
    return [{ name: "extension command context", ok: false, detail: describe(error) }];
  } finally {
    runtime?.dispose();
  }
}

/**
 * The view state machine, driven through the real webview entry points.
 *
 * Exists because of a bug that survived three rounds of fixes: what the webview
 * shows used to be three independent fields, and each fix updated some of them.
 * The last one was `postState()` discarding the delegation whenever a preview
 * was open, which silently undid the framing computed just above it.
 *
 * The point here is that nothing is hand-assembled: this drives
 * `handleMessage()` and reads what `postState()` actually posted. A test that
 * built `ChatState` itself — as the webview smoke script necessarily does —
 * cannot see a bug in the code that builds it.
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

    // Scanning helpers, not `.map().at()`: the latest posted message is usually
    // a `state`, so mapping first would read `undefined` off the tail.
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

    /**
     * View changes fire their state snapshot without awaiting it
     * (`void postState()`), so reading `lastState()` right after an action
     * races it. Poll until the expected shape lands — history and flag posts
     * are synchronous and need no waiting.
     */
    const waitForState = async (predicate: (snapshot: ChatState | undefined) => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 500 && !predicate(lastState()); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    // A session becoming the live one feeds its replayed user messages into
    // the composer's ↑ history (CLI initial-render parity); view round trips
    // must not. The host always re-flags `ready` — a reloaded webview starts
    // with an empty history — and the webview dedupes per transcript.
    expect("attach: replay populates input history", firstHistoryFlag() === true);

    // `ready` must hand the webview its fold threshold before the first
    // history replay: bubbles decide whether they fold while being built, and
    // the webview cannot read VS Code settings itself.
    await bridge.handleMessage({ type: "ready" });
    const foldThreshold = [...posted].reverse().find((message) => message?.type === "foldThreshold");
    expect(
      "ready: fold threshold delivered",
      foldThreshold !== undefined && foldThreshold.type === "foldThreshold" && foldThreshold.maxLines === readFoldLines(),
    );
    expect("ready: replay populates input history", lastHistoryFlag() === true);

    // Live: the parent is writable and is not "inside" anything.
    const live = lastState();
    expect("live: input enabled", live?.inputDisabled !== true);
    expect("live: not in a lane", live?.delegation?.role !== "child");

    // A lane with a live child session: the transcript switches to the child,
    // input is closed, and the banner has a lane to name.
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

    // Back to the parent, by the same route the banner's button uses. The
    // wait is what makes "writable again" meaningful: the pre-lane state was
    // writable too, and only the waited-for child state in between rules it
    // out as a stale match.
    await bridge.handleMessage({ type: "showLane" });
    await waitForState((s) => s?.inputDisabled !== true);
    const back = lastState();
    expect("back: role is parent", back?.delegation?.role === "parent");
    expect("back: writable again", back?.inputDisabled !== true);
    expect("back: parent transcript", lastTranscriptId() === parentTranscript);
    expect("back to live: replay does not re-populate input history", !lastHistoryFlag());

    // A subagent whose live session is gone is shown by replaying its file, and
    // both flags must be set. Ordinary top-level sessions no longer use replay:
    // selecting one constructs a live controller even while this one runs.
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
 * Offline check on which session a window opens with.
 *
 * Guarded because every wrong branch still lands the user in *a* session, just
 * not the right one — the failure is silent. The case that motivated it: a
 * brand new session writes no file until its first append, so "the user was
 * sitting in an empty new session" exists only in the host's memory, and
 * without it the next start resumed the previous conversation.
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
    // Drives the real startup path, then the real `attach()`, so what the host
    // would store is read from the callback rather than assumed.
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
    // The path is assigned up front, but the file behind it is not written
    // until the first append, so the session is not yet resumable.
    expect("new: file not written yet", fresh !== undefined && !existsSync(fresh));
    expect("new: remembered as a fresh session", remembered.length === 1 && lastRemembered() === undefined);

    const sessions = await SessionManager.list(cwd);
    let fileDetail = "skipped (no session on disk)";
    if (sessions.length > 0) {
      // Deliberately the oldest: the remembered file has to win over "most
      // recent", which is what the plain `--continue` behaviour would pick.
      const target = sessions[sessions.length - 1]!.path;
      const opened = await start({ mode: "file", path: target });
      expect("file: reopened the remembered session", opened === target);
      expect("file: remembered the same path", lastRemembered() === target);
      fileDetail = `reopened the oldest of ${sessions.length} session(s)`;
    }

    // A remembered file can be deleted between windows. That must degrade to
    // the most recent session, not start an empty session pinned to the dead
    // path (which would re-create the file the user deleted).
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

/**
 * Offline check on the resource listing shown above the transcript: it must
 * come back with the tool registry, and mark as inactive the tools pi
 * registers but does not activate (`grep`/`find`/`ls`, unless an extension
 * turns them on).
 */
export async function runResourceListingTest(cwd: string): Promise<DiagnosticResult[]> {
  try {
    const { session } = await createAgentSession({
      cwd,
      excludeTools: ["subagent"],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const sections = collectResourceSections({ session, cwd });
    session.dispose();
    const tools = sections.find((section) => section.name === "Tools")?.items ?? [];
    const active = tools.filter((tool) => !tool.inactive).map((tool) => tool.label);
    const inactive = tools.filter((tool) => tool.inactive).map((tool) => tool.label);
    // Extension labels are the entry file's basename, so a directory-form
    // extension that forgot its `pi.extensions` manifest shows up here as a
    // useless `index.ts` — worth seeing without opening the panel.
    const extensions = sections.find((section) => section.name === "Extensions")?.items.map((item) => item.label) ?? [];
    return [{
      name: "resource listing",
      ok: tools.length > 0 && active.includes("read"),
      detail: `sections: ${sections.map((section) => `${section.name} ${section.items.length}`).join(", ")}; extensions: ${extensions.join(", ") || "(none)"}; tools active: ${active.join(", ") || "(none)"}; inactive: ${inactive.join(", ") || "(none)"}`,
    }];
  } catch (error) {
    return [{ name: "resource listing", ok: false, detail: describe(error) }];
  }
}

/**
 * Milestone 1 live check: run one real prompt that must trigger a bash tool call
 * inside the extension host, using a throwaway in-memory session.
 */
export async function runLiveToolCallTest(cwd: string, log: (message: string) => void): Promise<DiagnosticResult[]> {
  const marker = `pi-spike-${Date.now()}`;
  const results: DiagnosticResult[] = [];
  const toolCalls: string[] = [];
  const seenEvents = new Set<string>();
  let text = "";

  try {
    const { session } = await createAgentSession({
      cwd,
      tools: ["bash"],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const unsubscribe = session.subscribe((event) => {
      seenEvents.add(event.type);
      if (event.type === "tool_execution_start") {
        toolCalls.push(event.toolName);
        log(`live test: tool ${event.toolName} ${JSON.stringify(event.args).slice(0, 200)}`);
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
      }
    });

    results.push({
      name: "live session",
      ok: true,
      detail: `model=${(session.model as { id?: string } | undefined)?.id ?? "(none)"}, thinking=${session.thinkingLevel}`,
    });

    let accepted: boolean | undefined;
    await session.prompt(
      `Use the bash tool exactly once to print the text ${marker}, then reply with that text and nothing else.`,
      { preflightResult: (success) => (accepted = success) },
    );
    unsubscribe();

    const agentError = session.agent.state.errorMessage;
    session.dispose();

    results.push({
      name: "prompt accepted",
      ok: accepted !== false,
      detail: `preflight=${String(accepted)}, events=${[...seenEvents].join(",") || "(none)"}`,
    });
    if (agentError) {
      results.push({ name: "agent error", ok: false, detail: agentError.slice(0, 500) });
    }
    results.push({
      name: "tool execution",
      ok: toolCalls.includes("bash"),
      detail: toolCalls.length ? `tools called: ${toolCalls.join(", ")}` : "no tool was called",
    });
    results.push({
      name: "assistant response",
      ok: text.includes(marker),
      detail: text.trim().slice(0, 200) || "(empty)",
    });
  } catch (error) {
    results.push({ name: "live prompt", ok: false, detail: describe(error) });
  }

  return results;
}
