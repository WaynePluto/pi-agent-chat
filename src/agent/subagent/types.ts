import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionServices,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { SubagentConfig } from "../config.js";
import type { ScopePrefix } from "../scope.js";

export const SUBAGENT_TOOL = "subagent";

export type LaneStatus = "running" | "completed" | "failed" | "stopped";

/**
 * 一路子代理未能完成任务的原因。
 *
 * 只列能机械判定的事实。「子代理主动放弃」刻意缺席：它与正常结束除了
 * 最后一条消息的措辞外无从区分，去猜就是把编造的理由摆在父代理面前。
 */
export type LaneFailure = "error" | "stopped_by_user" | "stopped_with_run";

/** 共享 model runtime 发出的模型形状。 */
export type SubagentModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/**
 * 用户该知道、父代理不该知道的某路消息。
 *
 * 用户配置的子代理默认模型不是父代理选的、也不是它能改的：解析不到时
 * 降级而不是废掉整路，交给父代理的汇报一字不提（告诉它只会读成「你的
 * 参数错了」）。能修拼写、能登录的只有用户。父代理自己指名的模型正
 * 相反：硬错误、在任何一路启动前抛出——它能自我修正的参数错误。
 */
export interface LaneNotice {
  readonly kind: "model_fallback";
  /** 解析不了的那个 spec。 */
  readonly requested: string;
  /**
   * 用户在哪里配置的它。目前只有一个来源，字段让通知在渲染处
   * 自解释。
   */
  readonly source: "setting";
  /** 实际使用的 `provider/modelId`；继承父会话时为 undefined。 */
  readonly using?: string;
}

export interface LaneState {
  readonly id: string;
  /** 父代理给这一路起的标题，否则取任务的短形式。 */
  readonly title: string;
  readonly task: string;
  readonly scope: readonly ScopePrefix[];
  sessionId?: string;
  sessionFile?: string;
  status: LaneStatus;
  failure?: LaneFailure;
  /** 一行描述这一路此刻在做什么。 */
  progress?: string;
  /** 最终回答，或失败详情。 */
  summary?: string;
  /** 经 `edit`/`write` 写过的文件；见 `bashMayHaveWritten` 的说明。 */
  writtenFiles: string[];
  /** 因越出范围被拒的写入数——切分不当的信号。 */
  scopeViolations: number;
  /**
   * 被拒的是哪些文件，按首次尝试排序。
   *
   * 与计数一起上报，让拒绝作为情报而非一句干巴巴的「有东西被挡了」
   * 到达父代理：这些正是这路的任务最终需要、而它没被给的文件，也只有
   * 父代理能据此行动。
   */
  deniedPaths: string[];
  /** 这一路跑过 shell 命令后为真；其写入无法跟踪。 */
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
  /** 某一路的子会话已存在；UI 现在可以显示它的 transcript。 */
  onLaneStarted(run: SubagentRun, lane: LaneState, session: AgentSession): void;
  /** 某一路的状态或进展变了；UI 应重画它的行。 */
  onLaneChanged(run: SubagentRun, lane: LaneState): void;
  /** 转发的子会话事件，供该路自己的 transcript。 */
  onLaneEvent(run: SubagentRun, lane: LaneState, event: AgentSessionEvent): void;
  /** 关于某一路装配的用户提示；绝不到达父代理。 */
  onLaneNotice(run: SubagentRun, lane: LaneState, notice: LaneNotice): void;
  onRunFinished(run: SubagentRun): void;
}

export interface SubagentHost {
  getSession(): AgentSession;
  getCwd(): string;
  /**
   * 一个子代理的 services。必须每路一份新的，绝不用父会话的、也绝不
   * 在路间共享：扩展运行时挂在 resource loader 上、被最后用它构造的
   * 会话占用。见 `runtime.ts` 的 `createSubagentServices()`。
   */
  createServices(): Promise<AgentSessionServices>;
  /**
   * 共享的 model runtime，用于在任何子会话存在之前解析模型覆盖。
   * 子会话经自己的 services 包拿到同一实例，在这里与在那里解析结果
   * 一致。
   */
  getModelRuntime(): ModelRuntime;
  bindExtensions(session: AgentSession, abortHandler: () => void): Promise<void>;
  getConfig(): SubagentConfig;
}
