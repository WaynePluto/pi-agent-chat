import type * as vscode from "vscode";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ChatEvent, HostMessage } from "../../shared/protocol.js";

/**
 * ChatBridge 驱动的 GUI surface：投递 host 消息、写日志，以及 bridge
 * 自己无从知晓的窗口级钩子。
 */
export interface BridgeHost {
  post(message: HostMessage): void;
  log(message: string): void;
  /**
   * 本 surface 当前所在的会话，下次窗口启动回到它。`undefined` 表示尚无
   * 内容写入的空会话：JSONL 首次追加才创建，「用户停在新空会话里」在
   * 磁盘上不留痕迹，只能记在这里。
   */
  rememberSession?(sessionFile: string | undefined): void;
  /** 另一个顶层 runtime 对该会话文件的 claim：揭示到前台（返回是否接管）与查询其所在位置。 */
  revealClaimedSession?(sessionFile: string): boolean;
  claimedSessionLocation?(sessionFile: string): "visible" | "background" | undefined;
  /**
   * 会话文件在本窗口任意位置的任务线角色。运行属于 controller 而非
   * surface：用户切走后父会话仍无面运行，其 lane 继续往各自文件追加；
   * 问窗口（而非只问本 bridge）才能让每个会话列表的徽章都说真话。
   */
  delegationRoleAt?(sessionFile: string): "parent" | "child" | undefined;
  /** 会话元数据 / 所有权在本窗口变化时：前者主动通知，后者是各顶层 bridge 共享订阅的窗口级事件。 */
  notifySessionsChanged?(): void;
  onDidChangeSessions?: vscode.Event<void>;
}

export interface CompactionQueuedPrompt {
  text: string;
  mode: "steer" | "followUp";
}

/**
 * 以会话文件回放展示子代理（背后已无 live lane）时使用的 lane id：只需
 * 在单个状态快照内稳定——横幅叫得出子代理名字，唯一动作是返回。
 */
export const REPLAYED_LANE_ID = "replayed";

/**
 * 设置变更后等多久再响应。设置界面逐键写值、数字步进器每步一发：不防抖
 * 的话，空会话上改三个子代理参数会重建三次，拖动折叠阈值也会让
 * transcript 重放同样多次。
 */
export const SETTINGS_DEBOUNCE_MS = 300;

/** 手动目录刷新的超时，超时回退缓存列表；与 CLI 模型选择器给 `refresh()` 的预算一致。 */
export const MODEL_REFRESH_TIMEOUT_MS = 15_000;

/**
 * webview 当前显示的内容（红线：单一联合类型）。它取代了三个独立字段
 * （displayedSession / displayedLaneId / preview）：合法组合过去只是约定——
 * replay 与 lane 都属「非 live 父会话」却必须互斥，且无机制保证；这里的
 * 每个 bug 都源于改了其一忘了其二，编译器无从发现。现在每个变体恰好携带
 * 其派生值所需的数据，切视图就是赋一个值，不得另设平行字段。
 */
export type View =
  | { kind: "live" }
  | { kind: "lane"; laneId: string; session: AgentSession }
  /**
   * 从会话文件只读回放的会话。仅用于子代理的 child session 已消失
   * （窗口重载之后）的情形：`laneTitle` 在回放持久化 transcript 的
   * 同时保住子代理的呈现框架。
   */
  | { kind: "replay"; file: string; title: string; events: ChatEvent[]; laneTitle: string };
