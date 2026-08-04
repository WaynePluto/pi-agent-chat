/**
 * Localized strings shown by the **extension host**: native dialogs, QuickPick
 * titles and the status notices it pushes into the transcript.
 *
 * Kept next to the webview dictionary so both sides stay worded consistently.
 * Like `protocol.ts`, this file must stay dependency-free — the webview bundle
 * imports it too and cannot pull in Node-only code.
 *
 * Deliberately NOT localized:
 * - `/` command names and descriptions (`agent/commands.ts`), which mirror the
 *   pi CLI catalogue verbatim so muscle memory carries over;
 * - the spike diagnostics commands, which are developer tooling;
 * - text produced by the SDK or by the model, which is passed through as-is.
 */

export interface LocalizedText {
  en: string;
  zh: string;
}

/** VS Code reports the display language as e.g. "zh-cn" / "en" / "ja". */
export function isChinese(language: string): boolean {
  return language.toLowerCase().startsWith("zh");
}

export function localize(text: LocalizedText, language: string): string {
  return isChinese(language) ? text.zh : text.en;
}

/** Fixed strings. */
export const sharedMessages = {
  /* Single-session mode ------------------------------------------------ */

  /** Native warning when new / resume / tree is attempted mid-run. */
  singleSessionGuard: {
    en: "Pi Agent Chat is single-session: stop the current run before switching or starting a session.",
    zh: "Pi Agent Chat 仅支持单会话模式：请先停止当前会话的运行，再切换或新建会话。",
  },

  /* Sessions ----------------------------------------------------------- */

  deleteActiveSession: {
    en: "Cannot delete the session that is currently open. Switch to another session first.",
    zh: "无法删除当前正在使用的 session，请先切换到其它 session。",
  },
  deleteSessionConfirm: {
    en: "Delete this session? The file will be removed permanently.",
    zh: "删除这个 session？文件将被移除，不可恢复。",
  },
  deleteSessionAction: { en: "Delete", zh: "删除" },
  resumeSessionTitle: { en: "Pi Agent Chat: resume session", zh: "Pi Agent Chat：恢复会话" },
  emptySessionTitle: { en: "(empty session)", zh: "（空会话）" },
  sessionNameTitle: { en: "Session name", zh: "会话名称" },
  importSessionTitle: { en: "Import Pi session", zh: "导入 Pi 会话" },
  exportSessionTitle: { en: "Export Pi session", zh: "导出 Pi 会话" },
  exportSessionAction: { en: "Export", zh: "导出" },
  sessionNotPersisted: {
    en: "this session is not persisted, nothing to export",
    zh: "当前会话未持久化，没有可导出的内容",
  },

  /* Model / thinking level --------------------------------------------- */

  noAuthenticatedModel: {
    en: "Pi Agent Chat: no authenticated model found.",
    zh: "Pi Agent Chat：没有可用的已认证模型。",
  },
  signInAction: { en: "Sign in", zh: "登录" },
  selectModelTitle: { en: "Pi Agent Chat: select model", zh: "Pi Agent Chat：选择模型" },
  selectThinkingTitle: { en: "Pi Agent Chat: select thinking level", zh: "Pi Agent Chat：选择思考等级" },
  noThinkingLevels: {
    en: "Pi Agent Chat: the current model has no selectable thinking levels.",
    zh: "Pi Agent Chat：当前模型没有可选的思考等级。",
  },
  current: { en: "current", zh: "当前" },
  modalityText: { en: "text", zh: "文本" },
  modalityImage: { en: "image", zh: "图像" },
  modelReasoning: { en: "reasoning", zh: "思考" },

  /* Settings menu -------------------------------------------------------- */

  settingsTitle: { en: "Pi Agent Chat: settings", zh: "Pi Agent Chat：设置" },
  settingsProviders: { en: "Providers", zh: "供应商" },
  settingsProvidersDetail: {
    en: "Sign in / configure a model provider",
    zh: "登录 / 配置模型供应商",
  },
  settingsShellPath: { en: "Shell path", zh: "Shell 路径" },
  settingsHelp: { en: "Command help", zh: "命令帮助" },
  renameRunningSession: {
    en: "Pi Agent Chat: cannot rename a session while a subagent is writing to it.",
    zh: "Pi Agent Chat：子代理正在写入该会话，暂时无法重命名。",
  },
  settingsHelpDetail: {
    en: "List built-in slash commands",
    zh: "查看内置斜杠命令列表",
  },
  settingsShellPathDetail: {
    en: "Shell used by the bash tool",
    zh: "bash 工具使用的 shell",
  },
  shellPathTitle: { en: "Pi Agent Chat: select shell", zh: "Pi Agent Chat：选择 shell" },
  shellPathCustom: { en: "Enter path manually...", zh: "手动输入路径…" },
  shellPathDefault: { en: "System default", zh: "系统默认" },
  shellPathDefaultDetail: {
    en: "Clear the custom shell path",
    zh: "清除自定义 shell 路径",
  },
  shellPathInputTitle: { en: "Pi Agent Chat: shell path", zh: "Pi Agent Chat：Shell 路径" },
  shellPathInputPrompt: {
    en: "Absolute path to the shell executable",
    zh: "shell 可执行文件的绝对路径",
  },
  shellPathNotFound: {
    en: "Pi Agent Chat: that path does not exist.",
    zh: "Pi Agent Chat：该路径不存在。",
  },
  shellPathCleared: {
    en: "shell path reset to system default (applies to new sessions)",
    zh: "shell 路径已恢复系统默认（对新会话生效）",
  },

  /* Login / logout ------------------------------------------------------ */

  noLoginProviders: {
    en: "Pi Agent Chat: no login providers available.",
    zh: "Pi Agent Chat：没有可登录的供应商。",
  },
  signInTitle: { en: "Pi Agent Chat: sign in to a provider", zh: "Pi Agent Chat：登录模型供应商" },
  oauthDescription: { en: "OAuth / subscription", zh: "OAuth / 订阅" },
  apiKeyDescription: { en: "API key", zh: "API key" },
  oauthLabel: { en: "OAuth", zh: "OAuth" },
  noStoredCredentials: {
    en: "Pi Agent Chat: no stored credentials to remove. Logout only removes credentials saved by login.",
    zh: "Pi Agent Chat：没有可移除的已保存凭据。登出只会移除通过登录保存的凭据。",
  },
  removeCredentialTitle: { en: "Pi Agent Chat: remove stored credential", zh: "Pi Agent Chat：移除已保存的凭据" },
  browserSignIn: {
    en: "Complete the sign-in in your browser, then return to VS Code.",
    zh: "请在浏览器中完成登录，然后回到 VS Code。",
  },
  deviceOpenPage: { en: "Open page & copy code", zh: "打开页面并复制验证码" },
  deviceCopyOnly: { en: "Copy code only", zh: "仅复制验证码" },

  /* Session tree -------------------------------------------------------- */

  treeNavigateTitle: { en: "Pi Agent Chat: navigate session tree", zh: "Pi Agent Chat：浏览会话树" },
  treeForkTitle: { en: "Pi Agent Chat: fork from user message", zh: "Pi Agent Chat：从历史用户消息分叉" },
  treeSwitchLabel: { en: "Switch to this point", zh: "切换到这个节点" },
  treeSwitchDetail: {
    en: "Continue in this branch, same session file",
    zh: "在该分支上继续，仍使用同一个会话文件",
  },
  treeForkLabel: { en: "Fork from here", zh: "从这里分叉" },
  treeForkDetail: { en: "Copy the branch into a new session file", zh: "把该分支复制到新的会话文件" },
  treeLabelLabel: { en: "Set or clear label", zh: "设置或清除标签" },
  treeLabelDetail: { en: "Bookmark this entry for later navigation", zh: "给该节点加书签，便于以后导航" },
  treeLabelInputTitle: { en: "Entry label (empty to clear)", zh: "节点标签（留空则清除）" },
  treeEmpty: { en: "this session has no navigable entries yet", zh: "当前会话还没有可导航的节点" },
  treeNavigationCancelled: { en: "navigation cancelled", zh: "已取消导航" },
  treeSwitched: { en: "switched to the selected branch point", zh: "已切换到所选的分支节点" },
  treeLabelCleared: { en: "label cleared", zh: "标签已清除" },
  forkNoUserMessage: { en: "no user message to fork from", zh: "没有可用于分叉的用户消息" },
  forkCancelled: { en: "fork cancelled", zh: "已取消分叉" },
  cloneEmpty: { en: "nothing to clone in an empty session", zh: "空会话没有可复制的内容" },
  cloneCancelled: { en: "clone cancelled", zh: "已取消复制" },
  inMemorySession: { en: "(in-memory)", zh: "（内存会话）" },

  /* Built-in commands --------------------------------------------------- */

  compacting: { en: "compacting context...", zh: "正在压缩上下文……" },
  noAssistantMessage: { en: "no assistant message to copy", zh: "没有可复制的助手消息" },
  copiedLastMessage: { en: "last assistant message copied", zh: "已复制最后一条助手消息" },

  /* Extension UI hooks -------------------------------------------------- */

  confirmYes: { en: "Yes", zh: "确定" },
} satisfies Record<string, LocalizedText>;

/** Strings with interpolated values. Both languages must take the same arguments. */
export const sharedTemplates = {
  /** Prompt prefix folded in before referenced `@file` lines when sending a message. */
  referencedFilesHeader: {
    en: (lines: string) =>
      `Referenced project files (relative to the workspace root; use the read tool to inspect them):\n${lines}`,
    zh: (lines: string) => `引用的项目文件（相对于工作区根目录，请使用 read 工具查看）：\n${lines}`,
  },
  diffEditorTitle: {
    en: (name: string) => `${name} (pi edit)`,
    zh: (name: string) => `${name}（pi 修改）`,
  },
  configuredDetail: {
    en: (label: string) => `$(check) configured: ${label}`,
    zh: (label: string) => `$(check) 已配置：${label}`,
  },
  ambientCredentials: {
    en: (provider: string) =>
      `${provider} uses ambient credentials (environment variables or config files). Set them outside of pi; there is nothing to store via login.`,
    zh: (provider: string) =>
      `${provider} 使用环境凭据（环境变量或配置文件）。请在 pi 之外设置它们，登录不会保存任何内容。`,
  },
  signedIn: {
    en: (provider: string) => `Pi Agent Chat: signed in to ${provider}.`,
    zh: (provider: string) => `Pi Agent Chat：已登录 ${provider}。`,
  },
  loginFailed: {
    en: (reason: string) => `Pi Agent Chat: login failed — ${reason}`,
    zh: (reason: string) => `Pi Agent Chat：登录失败 — ${reason}`,
  },
  removedCredential: {
    en: (provider: string) => `Pi Agent Chat: removed credential for ${provider}.`,
    zh: (provider: string) => `Pi Agent Chat：已移除 ${provider} 的凭据。`,
  },
  deviceCodeTitle: {
    en: (code: string) => `Pi Agent Chat: device sign-in code ${code}`,
    zh: (code: string) => `Pi Agent Chat：设备登录验证码 ${code}`,
  },
  deviceCodeDetail: {
    en: (uri: string, code: string) =>
      `Enter this code at:\n${uri}\n\nCode: ${code}\n(already copied to the clipboard)`,
    zh: (uri: string, code: string) => `请在以下页面输入验证码：\n${uri}\n\n验证码：${code}\n（已复制到剪贴板）`,
  },
  deviceCodeStatusBar: {
    en: (code: string) => `Pi Agent Chat sign-in code: ${code}`,
    zh: (code: string) => `Pi Agent Chat 登录验证码：${code}`,
  },
  /** QuickPick detail line for one model: input modalities, context window, max output. */
  modelCapabilities: {
    en: (input: string, context: string, maxOutput: string) =>
      `${input} · ${context} context · ${maxOutput} max output`,
    zh: (input: string, context: string, maxOutput: string) =>
      `${input} · ${context} 上下文 · ${maxOutput} 最大输出`,
  },
  compactionDone: {
    en: (before: number, after: number) => `compaction done: ${before} -> ~${after} tokens`,
    zh: (before: number, after: number) => `上下文压缩完成：${before} -> 约 ${after} tokens`,
  },
  sessionRenamed: {
    en: (name: string) => `session renamed to "${name}"`,
    zh: (name: string) => `会话已重命名为“${name}”`,
  },
  importedSession: {
    en: (path: string) => `imported ${path}`,
    zh: (path: string) => `已导入 ${path}`,
  },
  exportedSession: {
    en: (path: string) => `exported to ${path}`,
    zh: (path: string) => `已导出到 ${path}`,
  },
  shellPathSet: {
    en: (path: string) => `shell path set to ${path} (applies to new sessions)`,
    zh: (path: string) => `shell 路径已设置为 ${path}（对新会话生效）`,
  },
  treeLabelSet: {
    en: (label: string) => `label set: ${label}`,
    zh: (label: string) => `标签已设置：${label}`,
  },
  forkedInto: {
    en: (file: string) => `forked into ${file}`,
    zh: (file: string) => `已分叉到 ${file}`,
  },
  clonedInto: {
    en: (file: string) => `cloned into ${file}`,
    zh: (file: string) => `已复制到 ${file}`,
  },
};
