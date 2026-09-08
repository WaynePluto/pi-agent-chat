import {
  createAgentSessionFromServices,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { SubagentConfig } from "../config.js";
import { describe } from "../errors.js";
import { findScopeConflict, normalizeScopes, ScopeGuard, type ScopePrefix } from "../scope.js";
import { createScopedFileTools, SCOPED_TOOL_NAMES } from "../scoped-tools.js";
import { VSCODE_TERMINAL_TOOL } from "../vscode-terminal.js";
import { planModel } from "./model.js";
import { composePrompt, summarize } from "./prompt.js";
import { describeProgress, progressLine, snapshot } from "./progress.js";
import { report } from "./report.js";
import { defineSubagentTool } from "./tool.js";
import {
  SUBAGENT_TOOL,
  type LaneState,
  type SubagentHost,
  type SubagentModel,
  type SubagentObserver,
  type SubagentRun,
} from "./types.js";

/**
 * 子会话无论如何都不能触碰的工具名。
 *
 * 两个名字都归本窗口所有。`subagent` 防止子代理递归；`vscode_terminal`
 * 被排除是因为它要驱动的终端是*共享的可见*表面、前面只坐着一个人：
 * 多路往同一批终端里敲字（或各开一个）会交织成没人跟得住的东西，用户
 * 也无从回答一个分不清是哪一路在问的 prompt。子代理仍经 `bash` 跑
 * 命令，那不需要观众。排除名字同时意味着注册了其中任何一个的扩展都
 * 钻不进子会话。
 */
const NEVER_IN_CHILD = [SUBAGENT_TOOL, VSCODE_TERMINAL_TOOL];

/**
 * 父代理在一次工具调用里等待的同时，并行跑多个隔离子会话。
 *
 * 子代理写真实工作树，因此开跑前先立两条保证：每路声明自己可写的
 * 路径，且任何两份声明都指不到同一个文件。越界在文件操作层被拒绝，
 * 而不是在 prompt 里劝阻——见 `scoped-tools.ts`。
 *
 * 一路失败不做回滚。父代理被告知每路停下前写过什么，再决定怎么办；
 * 这个设计能站住，全靠 `edit`/`write` 的记账是完整的。
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
   * 为一个会话构建工具定义。
   *
   * 按会话创建而不是全局一份，因为配置的并行数会成为 schema 的数组
   * 上限：模型事前就知道天花板，而不是先提交超额再被拒。设置变更因此
   * 在该会话的工具集重建时生效。
   */
  createTool(config: SubagentConfig): ToolDefinition {
    return defineSubagentTool(config, (tasks, signal, onUpdate) => this.run(tasks, config, signal, onUpdate));
  }

  /** 停掉一路；其余继续跑，父代理仍会拿到完整汇报。 */
  async stopLane(laneId: string): Promise<void> {
    const session = this.sessions.get(laneId);
    if (!session) return;
    this.stopped.add(laneId);
    await session.abort();
  }

  /** 停掉全部。bridge 若想连父代理一起停，另行 abort。 */
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

    // 在启动任何东西之前解析并校验一切：一旦子代理开始写工作树，
    // 就没有干净回头路了。
    const prepared = tasks.map((entry, index) => {
      const task = entry.task.trim();
      if (!task) throw new Error(`Subagent ${index + 1}: task cannot be empty`);
      const scope = normalizeScopes(cwd, entry.scope);
      // 省略的覆盖与空的覆盖同义；两种模型都会发。
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
    // 在 run 存在之后发，提示才能挂到 UI 已认识的路上。
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
        // 排除集恒定生效：子代理无法递归，无限制的文件工具
        // 也永远回不来。
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
