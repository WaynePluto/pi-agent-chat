import { Type } from "typebox";
import {
  createAgentSessionFromServices,
  defineTool,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionServices,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { SubagentConfig } from "./config.js";
import { describe } from "./errors.js";
import { findScopeConflict, normalizeScopes, ScopeGuard, type ScopePrefix } from "./scope.js";
import { createScopedFileTools, SCOPED_TOOL_NAMES } from "./scoped-tools.js";

export const SUBAGENT_TOOL = "subagent";

/** Tool names a child session may never reach, whatever else it is given. */
const NEVER_IN_CHILD = [SUBAGENT_TOOL];

export type LaneStatus = "running" | "completed" | "failed" | "stopped";

/**
 * Why a lane did not finish its task.
 *
 * Only causes that can be established mechanically appear here. "The subagent
 * gave up" is deliberately absent: nothing distinguishes it from a normal
 * finish except the wording of the final message, and guessing at that would
 * put a fabricated reason in front of the parent agent.
 */
export type LaneFailure = "error" | "stopped_by_user" | "stopped_with_run";

/** A model, as the shared model runtime hands it out. */
type SubagentModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/**
 * Something the user should know about a lane, and the parent agent should not.
 *
 * A model named in the user's own configuration — the subagent default model
 * setting — is not something the parent agent chose or can correct, so a
 * missing one falls back instead of failing the lane, and the report handed to
 * the parent says nothing about it. Telling the parent would
 * read as "the arguments you sent were wrong" for a decision it never made.
 * The user, who is the only one who can fix the spelling or sign in, is told
 * here instead.
 *
 * A model the parent named itself is the opposite case and stays a hard error,
 * raised before any lane starts: that one is a mechanical argument mistake the
 * model can see and correct.
 */
export interface LaneNotice {
  readonly kind: "model_fallback";
  /** The spec that could not be resolved. */
  readonly requested: string;
  /**
   * Where the user configured it. Only one source exists, but the field
   * keeps the notice self-describing at its render site.
   */
  readonly source: "setting";
  /** `provider/modelId` actually used, or undefined when inheriting the parent's. */
  readonly using?: string;
}

export interface LaneState {
  readonly id: string;
  /** The title the parent gave this lane, else a short form of the task. */
  readonly title: string;
  readonly task: string;
  readonly scope: readonly ScopePrefix[];
  sessionId?: string;
  sessionFile?: string;
  status: LaneStatus;
  failure?: LaneFailure;
  /** One line describing what this lane is doing right now. */
  progress?: string;
  /** Final answer, or the failure detail. */
  summary?: string;
  /** Files written through `edit`/`write`; see the caveat on `bashMayHaveWritten`. */
  writtenFiles: string[];
  /** Writes refused for leaving the range — a signal that the split was wrong. */
  scopeViolations: number;
  /**
   * Which files it was refused, in first-attempt order.
   *
   * Reported next to the count so a refusal reaches the parent as information
   * rather than as a bare "something was blocked": these are exactly the files
   * this lane's task turned out to need, and the parent is the only one that
   * can act on them.
   */
  deniedPaths: string[];
  /** True once this lane ran a shell command, whose writes cannot be tracked. */
  bashMayHaveWritten: boolean;
  startedAt: number;
  endedAt?: number;
}

export interface SubagentRun {
  readonly id: string;
  readonly parent: AgentSession;
  readonly lanes: readonly LaneState[];
  readonly startedAt: number;
}

export interface SubagentObserver {
  onRunStarted(run: SubagentRun): void;
  /** A lane's child session exists; the UI can now show its transcript. */
  onLaneStarted(run: SubagentRun, lane: LaneState, session: AgentSession): void;
  /** A lane changed status or progress; the UI should re-render its row. */
  onLaneChanged(run: SubagentRun, lane: LaneState): void;
  /** Forwarded child session event, for the lane's own transcript. */
  onLaneEvent(run: SubagentRun, lane: LaneState, event: AgentSessionEvent): void;
  /** User-facing note about a lane's setup; never reaches the parent agent. */
  onLaneNotice(run: SubagentRun, lane: LaneState, notice: LaneNotice): void;
  onRunFinished(run: SubagentRun): void;
}

export interface SubagentHost {
  getSession(): AgentSession;
  getCwd(): string;
  /**
   * Services for one child. Must be a fresh bundle per lane, never the
   * parent's and never shared between lanes: the extension runtime hangs off
   * the resource loader and is claimed by whichever session was built from it
   * last. See `createSubagentServices()` in `runtime.ts`.
   */
  createServices(): Promise<AgentSessionServices>;
  /**
   * The shared model runtime, for resolving model overrides before any child
   * exists. Children get the same instance through their own services bundle,
   * so resolving here and resolving there agree.
   */
  getModelRuntime(): ModelRuntime;
  bindExtensions(session: AgentSession, abortHandler: () => void): Promise<void>;
  getConfig(): SubagentConfig;
}

/**
 * Runs several isolated child sessions at once while the parent waits inside
 * one tool call.
 *
 * Children write to the real working tree, so two guarantees are established
 * before anything starts: every lane declares the paths it may write, and no
 * two declarations can refer to the same file. Violations are refused at the
 * file-operation layer rather than discouraged in the prompt — see
 * `scoped-tools.ts`.
 *
 * Nothing is rolled back when a lane fails. The parent is told exactly what
 * each lane wrote before it stopped and decides what to do; that is only a
 * defensible design because the bookkeeping is complete for `edit`/`write`.
 */
export class SubagentCoordinator {
  private host?: SubagentHost;
  private observer?: SubagentObserver;
  private active?: SubagentRun;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly stopped = new Set<string>();
  private runStopped = false;
  private disposed = false;
  private counter = 0;

  constructor(private readonly log: (message: string) => void) {}

  attachHost(host: SubagentHost): void {
    this.host = host;
  }

  setObserver(observer: SubagentObserver | undefined): void {
    this.observer = observer;
  }

  get current(): SubagentRun | undefined {
    return this.active;
  }

  get isRunning(): boolean {
    return Boolean(this.active);
  }

  /**
   * Build the tool definition for one session.
   *
   * Created per session rather than once, because the configured width becomes
   * the schema's array limit: the model is told the ceiling up front instead of
   * proposing too many and being rejected. A changed setting therefore takes
   * effect when the session's tool set is rebuilt.
   */
  createTool(config: SubagentConfig): ToolDefinition {
    const TaskItem = Type.Object({
      task: Type.String({
        description:
          "Complete, self-contained instruction for this subagent. It starts with a fresh context and cannot ask questions.",
      }),
      scope: Type.Array(Type.String(), {
        description:
          "Paths this subagent may write to, relative to the working directory. Each entry is a directory or a single file, not a glob. Pass an empty array for a subagent that only needs to read or run commands. Writes outside these paths are refused. Ranges of different subagents must not overlap or the call is rejected before anything runs.",
      }),
      model: Type.Optional(Type.String({ description: "Model override as provider/modelId" })),
      title: Type.Optional(Type.String({ description: "Short label for this subagent in the UI" })),
    });

    return defineTool({
      name: SUBAGENT_TOOL,
      label: "Subagent",
      description:
        `Run up to ${config.maxSubagents} isolated subagents at the same time, each on its own task. ` +
        "Every subagent in one call runs concurrently with the others; separate calls run one after another, " +
        "so tasks that could overlap in time belong in the same call. " +
        "Every subagent starts with a fresh context, writes directly to the working tree within the paths it is given, " +
        "and cannot start further subagents. The parent session waits until all of them finish, then receives one report " +
        "listing each subagent's outcome and the files it wrote. Subagents cannot be given follow-up instructions, so each " +
        "task must be complete on its own; their write ranges must not overlap; failed subagents are reported, not undone.",
      promptSnippet: "Run several isolated subagents at once, each writing only within the paths it is given",
      parameters: Type.Object({
        tasks: Type.Array(TaskItem, {
          minItems: 1,
          maxItems: config.maxSubagents,
          description: "Subagents to run concurrently.",
        }),
      }),
      executionMode: "sequential",
      execute: async (_toolCallId, params, signal, onUpdate) => {
        const outcome = await this.run(params.tasks, config, signal, onUpdate);
        return outcome;
      },
    }) as ToolDefinition;
  }

  /** Stop one lane; the rest keep running and the parent still gets a report. */
  async stopLane(laneId: string): Promise<void> {
    const session = this.sessions.get(laneId);
    if (!session) return;
    this.stopped.add(laneId);
    await session.abort();
  }

  /** Stop every lane. The bridge aborts the parent separately if it wants to. */
  async stopAll(): Promise<void> {
    this.runStopped = true;
    await Promise.all([...this.sessions.values()].map((session) => session.abort()));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stopAll();
  }

  private async run(
    tasks: readonly {
      task: string;
      scope: string[];
      model?: string;
      title?: string;
    }[],
    config: SubagentConfig,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: { content: { type: "text"; text: string }[]; details: unknown }) => void) | undefined,
  ) {
    if (this.disposed) throw new Error("Subagent coordinator is disposed");
    if (this.active) throw new Error("A subagent run is already in progress");
    const host = this.host;
    if (!host) throw new Error("Subagent host is not attached");

    const cwd = host.getCwd();
    const parent = host.getSession();
    const modelRuntime = host.getModelRuntime();

    // Resolve and validate everything before starting anything: once a child is
    // writing to the working tree there is no clean way back.
    const prepared = tasks.map((entry, index) => {
      const task = entry.task.trim();
      if (!task) throw new Error(`Subagent ${index + 1}: task cannot be empty`);
      const scope = normalizeScopes(cwd, entry.scope);
      // An omitted override and an empty one mean the same thing; models send
      // both.
      const plan = planModel({
        requested: entry.model?.trim() || undefined,
        config,
        modelRuntime,
        parentModel: parent.model,
        index,
      });
      return { task, scope, model: plan.model, notices: plan.notices, title: entry.title };
    });

    const conflict = findScopeConflict(prepared.map((item) => item.scope));
    if (conflict) {
      const first = prepared[conflict.firstIndex];
      const second = prepared[conflict.secondIndex];
      throw new Error(
        `Subagents ${conflict.firstIndex + 1} and ${conflict.secondIndex + 1} both claim '${conflict.firstScope}' ` +
          `and '${conflict.secondScope}', which can refer to the same file. Nothing was started. ` +
          `Give them ranges that do not contain each other, or run them one after another.\n` +
          `  ${conflict.firstIndex + 1}: ${summarize(first?.task ?? "")}\n` +
          `  ${conflict.secondIndex + 1}: ${summarize(second?.task ?? "")}`,
      );
    }

    const runId = `run-${++this.counter}`;
    const lanes: LaneState[] = prepared.map((item, index) => ({
      id: `${runId}-lane-${index + 1}`,
      title: item.title?.trim() || summarize(item.task),
      task: item.task,
      scope: item.scope,
      status: "running",
      writtenFiles: [],
      scopeViolations: 0,
      deniedPaths: [],
      bashMayHaveWritten: false,
      startedAt: Date.now(),
    }));

    const run: SubagentRun = { id: runId, parent, lanes, startedAt: Date.now() };
    this.active = run;
    this.runStopped = false;
    this.stopped.clear();
    this.sessions.clear();

    const abortFromParent = () => {
      if (this.active !== run) return;
      void this.stopAll();
    };
    signal?.addEventListener("abort", abortFromParent, { once: true });

    this.observer?.onRunStarted(run);
    // After the run exists, so the notes attach to a lane the UI already knows.
    prepared.forEach((item, index) => {
      for (const notice of item.notices) this.observer?.onLaneNotice(run, lanes[index]!, notice);
    });
    this.log(`subagent run started: ${lanes.length} lanes`);

    const publish = () => {
      onUpdate?.({
        content: [{ type: "text", text: progressLine(lanes) }],
        details: { lanes: lanes.map(snapshot) },
      });
    };
    publish();

    try {
      await Promise.all(
        prepared.map((item, index) =>
          this.runLane(run, lanes[index]!, item, host, cwd, () => {
            this.observer?.onLaneChanged(run, lanes[index]!);
            publish();
          }),
        ),
      );
    } finally {
      signal?.removeEventListener("abort", abortFromParent);
      this.observer?.onRunFinished(run);
      this.active = undefined;
      this.sessions.clear();
    }

    this.log(`subagent run finished: ${lanes.filter((lane) => lane.status === "completed").length}/${lanes.length}`);
    return {
      content: [{ type: "text" as const, text: report(lanes) }],
      details: { lanes: lanes.map(snapshot) },
    };
  }

  private async runLane(
    run: SubagentRun,
    lane: LaneState,
    item: { task: string; scope: ScopePrefix[]; model?: SubagentModel },
    host: SubagentHost,
    cwd: string,
    changed: () => void,
  ): Promise<void> {
    const guard = new ScopeGuard(cwd, item.scope);
    let session: AgentSession | undefined;
    try {
      const services = await host.createServices();
      const result = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.create(cwd),
        model: item.model,
        thinkingLevel: run.parent.thinkingLevel,
        // The exclusions always apply, so no child can recurse and the
        // unrestricted file tools can never come back.
        excludeTools: [...NEVER_IN_CHILD, ...SCOPED_TOOL_NAMES],
        customTools: createScopedFileTools(cwd, guard),
      });
      session = result.session;
      lane.sessionId = session.sessionId;
      lane.sessionFile = session.sessionFile;
      this.sessions.set(lane.id, session);
      session.setSessionName(`Subagent: ${lane.title}`);
      this.observer?.onLaneStarted(run, lane, session);

      const unsubscribe = session.subscribe((event) => {
        this.observer?.onLaneEvent(run, lane, event);
        const progress = describeProgress(event);
        if (progress) {
          lane.progress = progress;
          if (progress.startsWith("running ")) lane.bashMayHaveWritten = true;
          changed();
        }
      });
      await host.bindExtensions(session, () => void this.stopLane(lane.id));
      changed();

      try {
        await session.prompt(composePrompt(item.task, item.scope));
      } finally {
        unsubscribe();
      }

      lane.writtenFiles = guard.writtenFiles;
      lane.scopeViolations = guard.violationCount;
      lane.deniedPaths = guard.deniedPaths;
      if (this.stopped.has(lane.id)) {
        lane.status = "stopped";
        lane.failure = "stopped_by_user";
        lane.summary = "Stopped by the user before completing its task.";
      } else if (this.runStopped) {
        lane.status = "stopped";
        lane.failure = "stopped_with_run";
        lane.summary = "Stopped together with the rest of the run.";
      } else if (session.agent.state.errorMessage) {
        lane.status = "failed";
        lane.failure = "error";
        lane.summary = session.agent.state.errorMessage;
      } else {
        lane.status = "completed";
        lane.summary = session.getLastAssistantText()?.trim() || "Finished without a textual response.";
      }
    } catch (error) {
      lane.writtenFiles = guard.writtenFiles;
      lane.scopeViolations = guard.violationCount;
      lane.deniedPaths = guard.deniedPaths;
      lane.status = "failed";
      lane.failure = "error";
      lane.summary = describe(error);
    } finally {
      lane.progress = undefined;
      lane.endedAt = Date.now();
      this.sessions.delete(lane.id);
      changed();
      session?.dispose();
    }
  }
}

/**
 * The text a child session is started with.
 *
 * The scope line states a fact about this run — the same category as telling
 * the model its working directory — and is backed by refusal at the file
 * layer, so it is not behavioural guidance the plugin invented. Everything
 * else the child is told comes from the parent's `task`.
 */
function composePrompt(task: string, scope: readonly ScopePrefix[]): string {
  const parts: string[] = [];
  parts.push(
    `You are one of several subagents running at the same time on this project. The others are working in different parts of it. You cannot see them, contact them, or wait for them, and their changes may appear in files outside your range while you work.`,
  );
  parts.push(
    scope.length > 0
      ? `Files you may write: ${scope.map((prefix) => prefix || "(entire project)").join(", ")}. ` +
          `Writes outside this range are refused. You can read anything.`
      : `You cannot write files: every write is refused. You can read anything and run commands.`,
  );
  parts.push(`Task: ${task}`);
  return parts.join("\n\n");
}

/** Short single-line form of a task, for titles and error messages. */
function summarize(task: string): string {
  const first = task.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return first.length > 60 ? `${first.slice(0, 57)}...` : first || "task";
}

/**
 * Decide which model one lane runs on, and what the user should be told.
 *
 * The order is: what the parent asked for, then the subagent default model
 * setting, then the parent's own model. Only the first of those is the parent
 * agent's decision, so only it fails loudly — before any child is started. The
 * configured source belongs to the user: an unresolvable one steps down to the
 * next entry and produces a `LaneNotice`, because failing the lane would waste
 * the whole task over a typo the parent cannot fix, and reporting it to the
 * parent would describe a choice it never made.
 *
 * Exported for the `subagent model selection` self-check in `diagnostics.ts`.
 */
export function planModel(options: {
  requested?: string;
  config: SubagentConfig;
  modelRuntime: ModelRuntime;
  parentModel?: SubagentModel;
  index: number;
}): { model?: SubagentModel; notices: LaneNotice[] } {
  const { requested, config, modelRuntime, parentModel, index } = options;
  const preferredProvider = parentModel?.provider;

  if (requested) {
    const model = findModel(modelRuntime, requested, preferredProvider);
    if (!model) {
      throw new Error(
        `Subagent ${index + 1}: model not found: "${requested}". Pass a configured model as provider/modelId, ` +
          `or omit the field to use the configured subagent model. Nothing was started.`,
      );
    }
    return { model, notices: [] };
  }

  const configured: { spec: string; source: LaneNotice["source"] }[] = [];
  if (config.defaultModel) configured.push({ spec: config.defaultModel, source: "setting" });

  const missed: typeof configured = [];
  let model: SubagentModel | undefined;
  for (const candidate of configured) {
    const resolved = findModel(modelRuntime, candidate.spec, preferredProvider);
    if (resolved) {
      model = resolved;
      break;
    }
    missed.push(candidate);
  }
  model ??= parentModel;

  const using = model ? `${model.provider}/${model.id}` : undefined;
  return {
    model,
    notices: missed.map((entry) => ({
      kind: "model_fallback",
      requested: entry.spec,
      source: entry.source,
      using,
    })),
  };
}

/**
 * Look a model spec up in the shared model runtime, or undefined.
 *
 * Two spellings are accepted. `provider/modelId` is unambiguous and is what the
 * tool schema documents. A bare model id is also accepted, because a session
 * refers to its own model that way. The parent's own provider wins a tie, so
 * a model offered by several providers resolves the way the session already
 * runs.
 */
function findModel(modelRuntime: ModelRuntime, spec: string, preferredProvider?: string): SubagentModel | undefined {
  const separator = spec.indexOf("/");
  if (separator > 0 && separator < spec.length - 1) {
    return modelRuntime.getModel(spec.slice(0, separator), spec.slice(separator + 1));
  }
  if (preferredProvider) {
    const preferred = modelRuntime.getModel(preferredProvider, spec);
    if (preferred) return preferred;
  }
  return modelRuntime.getModels().find((model) => model.id === spec);
}

/**
 * Turn a child event into the one line the UI shows for that lane.
 *
 * The parent produces no output while it waits, so these lines carry the whole
 * sense of progress. Returning undefined leaves the previous line in place.
 */
function describeProgress(event: AgentSessionEvent): string | undefined {
  if (event.type === "tool_execution_start") {
    const args = event.args as Record<string, unknown> | undefined;
    const path = typeof args?.path === "string" ? args.path : undefined;
    switch (event.toolName) {
      case "read":
        return path ? `reading ${path}` : "reading";
      case "edit":
        return path ? `editing ${path}` : "editing";
      case "write":
        return path ? `writing ${path}` : "writing";
      case "bash": {
        const command = typeof args?.command === "string" ? args.command : "";
        return `running ${command.length > 48 ? `${command.slice(0, 45)}...` : command || "a command"}`;
      }
      default:
        return event.toolName;
    }
  }
  if (event.type === "message_start") return "thinking...";
  return undefined;
}

function progressLine(lanes: readonly LaneState[]): string {
  const done = lanes.filter((lane) => lane.status !== "running").length;
  return `Subagents: ${done}/${lanes.length} finished`;
}

function snapshot(lane: LaneState) {
  return {
    id: lane.id,
    title: lane.title,
    scope: [...lane.scope],
    status: lane.status,
    failure: lane.failure,
    // Carried into the card: while the run is going this is the only visible
    // sign that anything is happening.
    progress: lane.progress,
    summary: lane.summary,
    writtenFiles: [...lane.writtenFiles],
    scopeViolations: lane.scopeViolations,
    deniedPaths: [...lane.deniedPaths],
    bashMayHaveWritten: lane.bashMayHaveWritten,
    sessionFile: lane.sessionFile,
    durationMs: lane.endedAt ? lane.endedAt - lane.startedAt : undefined,
  };
}

/**
 * The report the parent agent receives.
 *
 * Written to stand on its own: a session resumed in the CLI, where this tool
 * does not exist, must still be able to read what happened from the text alone.
 * Partial work is called out explicitly because "failed" reads as "nothing
 * happened", and here it usually does not mean that.
 */
function report(lanes: readonly LaneState[]): string {
  const completed = lanes.filter((lane) => lane.status === "completed").length;
  const lines: string[] = [
    `Subagents: ${completed}/${lanes.length} completed. All changes were written to the working tree and none were rolled back.`,
    "",
  ];

  for (const lane of lanes) {
    const mark = lane.status === "completed" ? "[ok]" : "[--]";
    const ranges = lane.scope.map((prefix) => prefix || ".").join(", ");
    lines.push(`${mark} ${lane.title}  scope: ${ranges}`);
    lines.push(`     ${statusLine(lane)}`);
    if (lane.summary) lines.push(...indent(lane.summary));
    if (lane.writtenFiles.length > 0) {
      const label = lane.status === "completed" ? "wrote" : "wrote before stopping";
      lines.push(`     ${label}: ${lane.writtenFiles.join(", ")}`);
    } else if (lane.status !== "completed") {
      lines.push("     wrote before stopping: (nothing)");
    }
    if (lane.scopeViolations > 0) {
      lines.push(
        `     refused ${lane.scopeViolations} write(s) outside its range — this task needed files it was not given.`,
      );
      if (lane.deniedPaths.length > 0) {
        lines.push(`     still unchanged, outside its range: ${lane.deniedPaths.join(", ")}`);
      }
    }
    if (lane.bashMayHaveWritten) {
      lines.push("     ran shell commands; any files those wrote are not listed above.");
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function statusLine(lane: LaneState): string {
  switch (lane.status) {
    case "completed":
      return "completed";
    case "stopped":
      return lane.failure === "stopped_by_user"
        ? "STOPPED BY THE USER — do not restart it unless asked"
        : "STOPPED with the rest of the run";
    case "failed":
      return "FAILED";
    default:
      return "still running";
  }
}

function indent(text: string): string[] {
  return text
    .split(/\r?\n/)
    .slice(0, 40)
    .map((line) => `     ${line}`);
}
