import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { resultText, toolFilePath } from "../history.js";
import { matchSkill } from "../skills.js";
import { sanitizeToolDetails } from "../tool-details.js";
import type { ChatBridge } from "./chat-bridge.js";
import { emitCombinedQueueUpdate, flushCompactionQueue } from "./compaction-queue.js";
import { offerRetry, markRetryOffer } from "./retry.js";
import { rememberSession, postResourceListing } from "./updates.js";
import { refreshSessions } from "./sessions-list.js";

/**
 * 把一条 SDK 会话事件翻译成 webview 消息与簿记。runtime 自己的会话与
 * 每条 live 子代理 lane 共用此函数：lane observer 以子会话对象路由子
 * 事件，lane transcript 因此与父会话行为完全一致。
 */
export function onSessionEvent(bridge: ChatBridge, session: AgentSession, event: AgentSessionEvent): void {
  // 文件在会话中途才出现（首次追加时惰性创建），attach 时记下的值很快过期。
  if (session === bridge.runtime.session) rememberSession(bridge);
  const toolKey = (id: string) => `${session.sessionId}:${id}`;
  // 订阅本事件的扩展刚跑过；agent_start 意味着上下文文件已随 system prompt 发出——据此点亮资源面板。
  if (bridge.activity.noteSessionEvent(session, event.type)) postResourceListing(bridge);
  switch (event.type) {
    case "agent_start":
      bridge.emit(session, { kind: "agent_start" });
      void bridge.postState();
      refreshSessions(bridge);
      break;
    case "agent_end":
      // 底层 run 可能在 Pi 重试 / 继续压缩之前结束；webview 在之后的 agent_settled 才关闭执行过程。
      bridge.emit(session, { kind: "agent_end" });
      void bridge.postState();
      break;
    case "agent_settled": /* agent_end 之后仍可能跟着重试、压缩或排队 prompt，
      在 SDK 报告自动续跑全部落定后才刷新。「轮次停在一条从未回来的请求上」
      在此刻成为稳定事实，重试提议因此挂在这里而非 auto_retry_end（见
      offerRetry()）。历史 lane 停在用户选择阅读的位置：既不把父 runtime
      切到子文件，也不把用户拽回来。 */
      bridge.emit(session, { kind: "agent_settled" });
      offerRetry(bridge, session);
      void bridge.postState();
      bridge.postEntryIds();
      refreshSessions(bridge);
      break;
    case "message_start":
      bridge.emit(session, { kind: "assistant_start" });
      break;
    case "message_update": {
      const inner = event.assistantMessageEvent;
      if (inner.type === "text_delta") bridge.emit(session, { kind: "text_delta", delta: inner.delta });
      else if (inner.type === "thinking_delta") bridge.emit(session, { kind: "thinking_delta", delta: inner.delta });
      break;
    }
    case "message_end":
      /* 供方失败编码在完成的 assistant 消息上（AgentState.errorMessage 要到
         turn_end 才有）。工具请求已算手动重发那次请求的成功应答；其后供方
         超时属于新一轮失败、自领新提议。assistant 消息携带最终的 usage /
         cache / cost，SDK 落盘后即刷新 footer（含只请求工具的响应）；SDK
         在 SessionManager 追加 message_end 之前通知订阅者，故等当前栈展开
         后再收集。新会话文件在首条 assistant 消息完成时才写盘，此处刷新让
         列表先见到它。 */
      bridge.emit(session, { kind: "assistant_end" });
      if (event.message.role === "assistant") {
        if (event.message.stopReason === "error") bridge.liveFailedResponses.add(session.sessionId);
        else bridge.liveFailedResponses.delete(session.sessionId);
      }
      if (
        event.message.role === "assistant" &&
        event.message.stopReason !== "error" &&
        event.message.stopReason !== "aborted"
      ) {
        const retry = bridge.activeManualRetries.get(session.sessionId);
        if (retry && !retry.succeeded) {
          retry.succeeded = true;
          markRetryOffer(bridge, session, retry.offerIndex, "succeeded", retry.sourceLeafId);
        }
      }
      if (event.message.role === "assistant") {
        queueMicrotask(() => void bridge.postState());
        refreshSessions(bridge);
      }
      if (event.message.role === "assistant" && event.message.stopReason === "error" && event.message.errorMessage) {
        bridge.emit(session, { kind: "error", text: event.message.errorMessage });
      }
      break;
    case "tool_execution_start":
      bridge.pendingToolArgs.set(toolKey(event.toolCallId), event.args);
      bridge.emit(session, {
        kind: "tool_start",
        id: event.toolCallId,
        name: event.toolName,
        args: event.args,
        skill: matchSkill(bridge.skillIndex, event.toolName, event.args, bridge.runtime.cwd),
      });
      break;
    case "tool_execution_update":
      bridge.emit(session, {
        kind: "tool_update",
        id: event.toolCallId,
        text: resultText(event.partialResult),
        // 未结束工具的实时负载：与最终结果同条件清洗——它也要过 postMessage。
        details: sanitizeToolDetails(event.toolName, event.partialResult?.details),
      });
      break;
    case "tool_execution_end": {
      const details = (event.result?.details ?? {}) as { patch?: string };
      const key = toolKey(event.toolCallId);
      const args = bridge.pendingToolArgs.get(key);
      bridge.pendingToolArgs.delete(key);
      bridge.emit(session, {
        kind: "tool_end",
        id: event.toolCallId,
        name: event.toolName,
        isError: event.isError,
        text: resultText(event.result),
        patch: typeof details.patch === "string" ? details.patch : undefined,
        path: toolFilePath(args, bridge.runtime.cwd),
        details: sanitizeToolDetails(event.toolName, event.result?.details),
        skill: matchSkill(bridge.skillIndex, event.toolName, args, bridge.runtime.cwd),
      });
      break;
    }
    case "queue_update":
      // SDK 把 /skill:* 展开成完整 <skill> 块后才排队；队列对账保持短命令形式，并计入压缩期间宿主持有的提交。
      emitCombinedQueueUpdate(bridge, session, event.steering, event.followUp);
      break;
    case "compaction_start": /* `/compact` 已发过命令级的开始提示；手动压缩 API 不发
      agent_settled，把生命周期提示折进 work block 会让该块永远「运行中」。
      完成情况由 compaction_end 发出的持久压缩边界展示，只有自动压缩才有这里的提示。 */
      if (event.reason !== "manual") {
        bridge.emit(session, { kind: "status", text: `compacting context (${event.reason})...` });
      }
      void bridge.postState();
      break;
    case "compaction_end":
      if (event.reason !== "manual") {
        bridge.emit(session, { kind: "status", text: event.errorMessage ? `compaction failed: ${event.errorMessage}` : "compaction done" });
      }
      if (event.result) {
        bridge.emit(session, {
          kind: "compaction_boundary",
          summary: event.result.summary,
          tokensBefore: event.result.tokensBefore,
          estimatedTokensAfter: event.result.estimatedTokensAfter,
        });
      }
      void bridge.postState();
      void flushCompactionQueue(bridge, session, event.willRetry);
      break;
    case "auto_retry_start":
      bridge.emit(session, { kind: "status", text: `retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}` });
      break;
    case "auto_retry_end": /* 成功本身就是证据：本事件发于成功的 message_end 之后，
      重试的消息已经流过，此时再发提示会在那条消息后面新开一个 work
      block——唯一读起来错位的落点。失败保留：它是「为什么后面没有消息」
      的唯一解释，其后无文字时自然折回装着重试历史的块。重发提议刻意挂
      agent_settled 而非这里（见 offerRetry()）。 */
      if (!event.success) {
        bridge.emit(session, { kind: "status", text: `retry failed: ${event.finalError ?? "unknown"}` });
      }
      break;
    case "session_info_changed":
      void bridge.postState();
      break;
    default:
      break;
  }
}
