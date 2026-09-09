import * as vscode from "vscode";
import type { WebviewMessage } from "../../shared/protocol.js";
import { formatHelp, runBuiltinCommand } from "../commands.js";
import { describe } from "../errors.js";
import { t, tf } from "../i18n.js";
import { stripImageAttachmentMarkup, imageAttachmentMarkup } from "../images.js";
import { resolveInvocation } from "../invocations.js";
import { invokedSkill } from "../skills.js";
import { editEntryLabel, forkFromEntry, navigateSessionTree, switchToEntry } from "../session-tree.js";
import { openSettingsMenu } from "../settings-menu.js";
import { openEditDiff } from "../diff-view.js";
import { manageScopedModels } from "../model-picker.js";
import type { ChatBridge } from "./chat-bridge.js";
import { attachImage, takeAttachments } from "./attachments.js";
import { builtinActions, modelPickerUi, pickModel, setModel, setThinkingLevel } from "./actions.js";
import { dequeueAll, queueDuringCompaction } from "./compaction-queue.js";
import {
  deleteSession,
  renameSession,
  setSessionsVisible,
} from "./sessions-list.js";
import { postContentWidth, postFoldThreshold, postShowThinking } from "./settings.js";

/** 处理一条来自 webview 的消息。 */
export async function handleMessage(bridge: ChatBridge, message: WebviewMessage): Promise<void> {
  switch (message.type) {
    case "ready":
      /* 先阈值后历史：气泡在构建时决定折不折叠，值必须先于首次回放到位。
         webview 也可能带着空的输入历史被（重）加载——是否重新灌入由它
         自己的按 transcript 记忆决定。 */
      postFoldThreshold(bridge);
      postShowThinking(bridge);
      postContentWidth(bridge);
      bridge.postHistory(true);
      bridge.postCommands();
      bridge.postResources();
      await bridge.postState();
      break;
    case "prompt":
      await sendPrompt(bridge, message.text, message.streamingBehavior, message.references, message.imageIds);
      break;
    case "attachImage":
      await attachImage(bridge, message.requestId, message);
      break;
    case "detachImage":
      bridge.pendingImages.delete(message.id);
      break;
    case "listProjectFiles":
      await listProjectFiles(bridge, message.requestId, message.query, message.includeIgnored);
      break;
    case "abort":
      await abortDisplayedSession(bridge);
      await bridge.postState();
      break;
    case "retry":
      await bridge.retryFailedRequest();
      break;
    case "continue":
      await bridge.continueStoppedRun();
      break;
    case "dequeue":
      dequeueAll(bridge);
      break;
    case "newSession":
      if (bridge.guardStreaming()) break;
      await bridge.runtime.newSession();
      await bridge.attach();
      break;
    case "sessionsVisible":
      setSessionsVisible(bridge, message.visible);
      break;
    case "listCommands":
      bridge.postCommands();
      break;
    case "resumeSession":
      // 回放中的历史 lane 可以不替换任何东西地返回 runtime 自己的父会话。
      if (message.file === bridge.runtime.session.sessionFile) {
        bridge.setView({ kind: "live" });
        break;
      }
      if (bridge.guardStreaming()) break;
      if (await bridge.runtime.switchSession(message.file)) await bridge.attach();
      break;
    case "revealSession":
      bridge.host.revealClaimedSession?.(message.file);
      break;
    case "showLane":
      bridge.showLane(message.laneId, message.sessionFile, message.title);
      break;
    case "stopLane":
      await bridge.runtime.subagents.stopLane(message.laneId);
      break;
    case "deleteSession":
      await deleteSession(bridge, message.file);
      break;
    case "renameSession":
      await renameSession(bridge, message.file);
      break;
    case "renameCurrentSession":
      await renameSession(bridge);
      break;
    case "openSessionTree":
      if (bridge.guardStreaming()) break;
      await navigateSessionTree(bridge.runtime, builtinActions(bridge));
      await bridge.attach();
      break;
    case "entryAction":
      await runEntryAction(bridge, message.action, message.entryId);
      break;
    case "listModels":
      await bridge.postModels();
      break;
    case "setModel":
      await setModel(bridge, message.provider, message.modelId);
      break;
    case "pickModel":
      await pickModel(bridge);
      break;
    case "login":
      await bridge.login();
      break;
    case "logout":
      await bridge.logout();
      break;
    case "setThinkingLevel":
      setThinkingLevel(bridge, message.level);
      await bridge.postState();
      break;
    case "openSettings": {
      const status = (text: string) => bridge.emitCommandStatus(text);
      await openSettingsMenu(bridge.runtime, {
        login: async () => {
          await bridge.login();
        },
        status,
        error: (text: string) => bridge.emitCommandError(text),
        help: () => status(formatHelp()),
        manageScopedModels: async () => {
          await manageScopedModels(bridge.runtime, modelPickerUi(bridge));
          await bridge.postModels();
        },
        refreshModels: async () => {
          await bridge.refreshModelCatalog();
        },
        commandsChanged: () => bridge.postCommands(),
      });
      await bridge.postState();
      break;
    }
    case "openDiff":
      await openEditDiff(bridge.diffProvider, message.path, message.patch);
      break;
    case "openFile":
      await vscode.window.showTextDocument(vscode.Uri.file(message.path));
      break;
    case "copyText":
      await vscode.env.clipboard.writeText(message.text);
      break;
  }
}

export async function abortDisplayedSession(bridge: ChatBridge): Promise<void> {
  if (bridge.view.kind === "replay") return; // 静态 transcript，无运行可停
  const displayed = bridge.displayedSession;
  if (displayed.isCompacting) {
    displayed.abortCompaction();
    return;
  }
  // 在 lane 内部，停止按钮只停那一路；其余照跑，父会话仍收到完整汇报。
  if (bridge.view.kind === "lane") {
    await bridge.runtime.subagents.stopLane(bridge.view.laneId);
    return;
  }
  if (!bridge.activeRun) {
    await bridge.runtime.session.abort();
    return;
  }
  // 从父会话发起则停整个 run：先各路 lane，再父会话。
  await bridge.runtime.subagents.stopAll();
  bridge.runtime.session.clearQueue();
  await bridge.runtime.session.abort();
}

/**
 * 运行中的 runtime 不能替换自己的会话。并行顶层工作走另一个
 * surface/controller，而不是中止这一个。
 */
export function guardStreaming(bridge: ChatBridge): boolean {
  if (!bridge.runtime.session.isStreaming && !bridge.runtime.session.isCompacting) return false;
  bridge.emitCommandError(t("singleSessionGuard"));
  return true;
}

/**
 * 应用一次来自 transcript 气泡的会话树操作。switch 与 fork 会改变
 * transcript 应显示的内容，故经 attach() 重放；label 只是给条目加注，
 * 刷新 id / label 映射即可。
 */
export async function runEntryAction(bridge: ChatBridge, action: "switch" | "fork" | "label", entryId: string): Promise<void> {
  if (bridge.view.kind !== "live" || bridge.activeRun) return;
  if (action !== "label" && bridge.guardStreaming()) return;
  const ui = builtinActions(bridge);
  try {
    if (action === "switch") await switchToEntry(bridge.runtime, entryId, ui);
    else if (action === "fork") await forkFromEntry(bridge.runtime, entryId, ui);
    else await editEntryLabel(bridge.runtime, entryId, ui);
  } catch (error) {
    bridge.reportError(bridge.runtime.session, `${action} failed`, error, "command");
    return;
  }
  if (action === "label") bridge.postEntryIds();
  else await bridge.attach();
}

/** 应答 webview 的 @ 项目路径查询；错误内联上报，绝不抛出。 */
export async function listProjectFiles(bridge: ChatBridge, requestId: number, query: string, includeIgnored: boolean): Promise<void> {
  try {
    const items = await bridge.projectFiles.search(bridge.runtime.cwd, query, includeIgnored);
    bridge.host.post({ type: "projectFiles", requestId, items });
  } catch (error) {
    const messageText = describe(error);
    bridge.host.log(`project file search failed: ${messageText}`);
    bridge.host.post({ type: "projectFiles", requestId, items: [], error: messageText });
  }
}

export async function sendPrompt(
  bridge: ChatBridge,
  text: string,
  streamingBehavior?: "steer" | "followUp",
  references?: string[],
  imageIds?: string[],
): Promise<void> {
  /* 只有父会话接受输入，且仅当它是 live 视图；另两个视图只读——从它们
     排队的 prompt 会落进用户正不在看的会话。 */
  if (bridge.view.kind !== "live") return;
  let trimmed = text.trim();

  /* 附件在空文本检查之前解析：单独一张图也是一条消息，其标记正是让文本
     块非空的东西（SDK 总把它放最前，供方会拒绝空文本块）。 */
  const attachments = takeAttachments(bridge, imageIds);
  if (attachments.length > 0) {
    const markup = attachments.map((item) => imageAttachmentMarkup(item.name, item.hints));
    trimmed = `${trimmed ? `${trimmed}\n\n` : ""}${markup.join("\n")}`;
  }

  // 校验不可信的 webview 路径，并作为纯文本折进 prompt；文件与目录由模型自己经工具查看。
  if (references?.length) {
    try {
      const validated = await bridge.projectFiles.validate(bridge.runtime.cwd, references);
      if (validated.paths.length > 0) {
        const directories = new Set(validated.directories);
        const lines = validated.paths.map((path) => {
          const flags: string[] = [];
          if (validated.ignored.includes(path)) flags.push("gitignored");
          if (validated.sensitive.includes(path)) flags.push("potentially sensitive");
          const displayPath = directories.has(path) ? `${path}/` : path;
          return `@${displayPath}${flags.length ? ` (${flags.join(", ")})` : ""}`;
        });
        trimmed = `${trimmed ? `${trimmed}\n\n` : ""}${tf("referencedFilesHeader", lines.join("\n"))}`;
      }
    } catch (error) {
      bridge.reportError(bridge.runtime.session, "file reference rejected", error, "command");
      return;
    }
  }
  if (!trimmed) return;

  /* 内置命令是宿主 UI 的事，其余（提示词模板、扩展命令、/skill:*）由
     session 展开；invocation 必须在 prompt() 之前解析——它会把 /模板 改写
     成展开后的正文、把扩展命令整个吞掉。 */
  try {
    if (await runBuiltinCommand(bridge.runtime, trimmed, builtinActions(bridge))) return;
  } catch (error) {
    bridge.reportError(bridge.runtime.session, "command failed", error, "command");
    return;
  }

  const session = bridge.runtime.session;
  const invocation = resolveInvocation(session, trimmed);
  const extensionCommand = invocation.isExtensionCommand;
  if (session.isCompacting && !extensionCommand) {
    queueDuringCompaction(bridge, session, trimmed, streamingBehavior ?? "followUp");
    return;
  }

  const streaming = session.isStreaming && !extensionCommand;
  const mode = streaming ? (streamingBehavior ?? "followUp") : undefined;
  // SDK 在 prompt() 内部展开 /skill:<name>；此处发出的文本仍是命令形式，技能从命令本身解析。
  bridge.emit(session, {
    kind: "user_message",
    text: stripImageAttachmentMarkup(trimmed),
    mode,
    skill: invokedSkill(bridge.skillIndex, trimmed),
    prompt: invocation.prompt,
    extension: invocation.extension,
    images: attachments.length > 0 ? attachments.map(({ mimeType, data, name }) => ({ mimeType, data, name })) : undefined,
  });
  try {
    if (extensionCommand) bridge.extensionCommandDepth += 1;
    await session.prompt(trimmed, {
      streamingBehavior: mode,
      images: attachments.length > 0 ? attachments.map(({ mimeType, data }) => ({ type: "image", mimeType, data })) : undefined,
    });
  } catch (error) {
    bridge.reportError(bridge.runtime.session, "prompt failed", error);
  } finally {
    if (extensionCommand) bridge.extensionCommandDepth -= 1;
    await bridge.postState();
  }
}
