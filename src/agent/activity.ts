import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ChatEvent } from "../shared/protocol.js";

/**
 * 记录资源面板各栏里哪些资源在当前会话中真正生效过，供「本会话用过」
 * 的着色。有两栏无法只靠 transcript 归因：Context 文件每次请求都无条件
 * 拼进 system prompt、不留痕迹，有过一次请求就已全部交给过模型；扩展
 * 只有命令执行或工具被调才上 transcript，只装 handler 的扩展（最常见
 * 形态）永不点亮，改按「它订阅的事件被 emit 过」判定。
 *
 * 两种判读都刻意取宽口径：回答「这次对话里真的生效了吗」。
 */

/**
 * SDK-MIRROR: `core/agent-session.ts` 在 `bindExtensions()` 里发
 * `session_start`（紧随其后是 `resources_discover`），因此监听它们的
 * 扩展在绑定完成前就已运行。`project_trust` 更早，在 resource loader
 * 加载扩展时发出。
 */
const BIND_EVENTS = ["session_start", "resources_discover", "project_trust"] as const;

/**
 * SDK 在本宿主某个会话事件前后发出的扩展事件，按观察到的
 * `AgentSessionEvent` 类型作键。名字与会话事件逐字相同的（`agent_start`、
 * `message_end`、`tool_execution_*` 等）无需条目，按名匹配。
 *
 * SDK-MIRROR: emit 位置在 `core/agent-session.ts` 与 `core/agent.ts`
 * （一次运行的 `emitInput` / `emitBeforeAgentStart` / `emitContext` /
 * `emitBeforeProviderRequest` / `emitBeforeProviderHeaders`，工具调用的
 * `emitToolCall` / `emitToolResult`）。
 */
const COMPANION_EVENTS: Readonly<Record<string, readonly string[]>> = {
  agent_start: ["input", "before_agent_start", "context", "before_provider_request", "before_provider_headers", "turn_start"],
  agent_end: ["turn_end"],
  message_end: ["after_provider_response"],
  tool_execution_start: ["tool_call"],
  tool_execution_end: ["tool_result"],
  compaction_start: ["session_before_compact"],
  compaction_end: ["session_compact"],
  thinking_level_changed: ["thinking_level_select"],
};

/** 能证明会话已向模型发出过请求的历史事件。 */
const REQUEST_SENT_KINDS: ReadonlySet<ChatEvent["kind"]> = new Set([
  "assistant_message",
  "assistant_start",
  "thinking_message",
  "tool_start",
  "tool_end",
]);

/** 交给清单构建器的只读视图。 */
export interface ResourceActivity {
  /** system prompt（含 context 文件）一旦发出即为真。 */
  readonly contextUsed: boolean;
  /** 该扩展的命令、工具、handler 或错误被见到过则为真。 */
  isExtensionUsed(path: string): boolean;
}

/**
 * {@link ResourceActivity} 的可变侧。每个标记方法都返回是否有变化，
 * 调用方只在面板真的会变样时才重发清单。
 */
export class ActivityTracker implements ResourceActivity {
  private readonly extensions = new Set<string>();
  private requestSent = false;

  get contextUsed(): boolean {
    return this.requestSent;
  }

  isExtensionUsed(path: string): boolean {
    return this.extensions.has(path);
  }

  /** 全部清空；另一个会话 attach 时调用。 */
  reset(): void {
    this.extensions.clear();
    this.requestSent = false;
  }

  /** 扩展确实运行过（handler 抛错、命令执行等直接证据）。 */
  markExtension(path: string): boolean {
    if (this.extensions.has(path)) return false;
    this.extensions.add(path);
    return true;
  }

  /** 回放历史：出现 assistant 输出即说明 system prompt 发出去过。 */
  noteHistory(events: readonly ChatEvent[]): boolean {
    if (this.requestSent) return false;
    if (!events.some((event) => REQUEST_SENT_KINDS.has(event.kind))) return false;
    this.requestSent = true;
    return true;
  }

  /** 扩展已绑定：启动期的 handler 此刻都已跑过。 */
  noteBind(session: AgentSession): boolean {
    return this.markByEvents(session, BIND_EVENTS);
  }

  /** 观察到一个 `AgentSessionEvent`；标记它触及的所有人。 */
  noteSessionEvent(session: AgentSession, type: string): boolean {
    // 一次运行开始即意味着 system prompt（含 context 文件）正在
    // 发往供应商。
    let changed = false;
    if (type === "agent_start" && !this.requestSent) {
      this.requestSent = true;
      changed = true;
    }
    return this.markByEvents(session, [type, ...(COMPANION_EVENTS[type] ?? [])]) || changed;
  }

  /** 标记订阅了 `events` 中任一事件的全部扩展。 */
  private markByEvents(session: AgentSession, events: readonly string[]): boolean {
    let changed = false;
    for (const extension of loadedExtensions(session)) {
      if (this.extensions.has(extension.path)) continue;
      if (!events.some((event) => (extension.handlers.get(event)?.length ?? 0) > 0)) continue;
      this.extensions.add(extension.path);
      changed = true;
    }
    return changed;
  }
}

/** 已加载的扩展；会话报不出来时返回空。 */
function loadedExtensions(session: AgentSession): Array<{ path: string; handlers: Map<string, unknown[]> }> {
  try {
    return session.resourceLoader.getExtensions().extensions;
  } catch {
    return [];
  }
}
