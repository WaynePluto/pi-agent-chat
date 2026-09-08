/**
 * 本地化字典（`sharedMessages`）的固定文案，以及各处共用的 `LocalizedText`
 * 类型与 `isChinese` / `localize` 辅助函数。属于 `shared/messages` 模块——
 * 模块契约（零依赖；webview bundle 也会导入）见 `../messages.ts`。
 */
export interface LocalizedText {
  en: string;
  zh: string;
}

/** VS Code 报告显示语言形如 "zh-cn" / "en" / "ja"。 */
export function isChinese(language: string): boolean {
  return language.toLowerCase().startsWith("zh");
}

export function localize(text: LocalizedText, language: string): string {
  return isChinese(language) ? text.zh : text.en;
}

/** 固定文案。 */
export const sharedMessages = {
  /* —— 图片附件 --------------------------------------------------------------- */

  /** webview 交来零字节（空文件 / 空剪贴板图片）。 */
  imageEmpty: {
    en: "That image is empty.",
    zh: "这张图片是空的。",
  },
  /** 超过 `MAX_ATTACHMENT_BYTES`，解码前即拒绝。 */
  imageTooLarge: {
    en: "That image is too large to attach.",
    zh: "图片过大，无法作为附件发送。",
  },
  /** photon 解不了：不是图片，或编码不受支持。 */
  imageUnsupported: {
    en: "That file could not be read as an image.",
    zh: "无法将该文件读取为图片。",
  },
  /** 缩到 1x1 编码后仍超供应商内联上限。 */
  imageTooLargeToResize: {
    en: "That image could not be scaled below the inline size limit.",
    zh: "图片无法缩小到内联体积上限以内。",
  },
  /** 当前模型不支持视觉时附加图片。 */
  imageModelNoVision: {
    en: "The current model cannot read images; switch models before sending.",
    zh: "当前模型不支持读图，发送前请先切换模型。",
  },
  /** 共享设置开了 `images.blockImages`：SDK 以占位文本替代。 */
  imageBlockedBySettings: {
    en: "Image reading is disabled in settings.json; the model receives a placeholder instead.",
    zh: "settings.json 中已禁用读图，模型收到的是占位文本。",
  },
  // composer 已持有 `MAX_IMAGE_ATTACHMENTS` 张图片。
  imageTooMany: {
    en: "Too many images attached to one message.",
    zh: "单条消息的图片数量已达上限。",
  },
  /* —— 活动运行时替换防护 ------------------------------------------------------ */

  /** new / resume / tree 试图替换运行中会话时的错误提示。 */
  singleSessionGuard: {
    en: "This session is still running and cannot be replaced. Start a New session to let it finish in the background, or stop it first.",
    zh: "此会话仍在运行，无法直接替换。可点击「新会话」让它在后台继续，或先停止当前运行。",
  },

  /* —— 重试 ---------------------------------------------------------------- */

  /**
   * 请求未返回的那一轮的收尾提示，带重试动作。刻意不谈原因：自动重试放弃的
   * 连接错误、关掉重试后的超时、本来就不可重试的错误，全都盖住。
   */
  retryInterrupted: {
    en: "The last request did not complete, so no reply arrived.",
    zh: "上一次请求没有完成，未收到回复。",
  },

  /** 会话已越过失败点之后才点重试。 */
  retryUnavailable: {
    en: "Nothing to retry: this session has moved on since that request failed. Send a message to continue.",
    zh: "没有可重试的请求：该请求失败后会话已经继续了。发送一条消息即可继续。",
  },

  /* —— 会话 ----------------------------------------------------------------- */

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

  /* —— 模型 / 思考等级 ------------------------------------------------------- */

  noAuthenticatedModel: {
    en: "Pi Agent Chat: no authenticated model found.",
    zh: "Pi Agent Chat：没有可用的已认证模型。",
  },
  signInAction: { en: "Sign in", zh: "登录" },
  selectModelTitle: { en: "Pi Agent Chat: select model", zh: "Pi Agent Chat：选择模型" },

  current: { en: "current", zh: "当前" },
  favoriteModels: { en: "Frequently used", zh: "常用模型" },
  addFavoriteModel: { en: "Add to frequently used models", zh: "设为常用模型" },
  removeFavoriteModel: { en: "Remove from frequently used models", zh: "移出常用模型" },
  favoriteModelsTitle: { en: "Pi Agent Chat: frequently used models", zh: "Pi Agent Chat：常用模型" },
  favoriteModelsPlaceholder: {
    en: "Select the models to show first; selecting all or none removes the filter",
    zh: "勾选优先展示的模型；全选或全不选则取消筛选",
  },
  favoriteModelsCleared: {
    en: "frequently used models cleared: every model is offered",
    zh: "已清空常用模型：选择器将列出全部模型",
  },
  setDefaultModel: { en: "Set current model as default", zh: "将当前模型设为默认" },
  /** 移交给完整原生模型选择器的 composer 菜单行。 */
  otherModels: { en: "Other models...", zh: "其他模型…" },
  defaultModelMarker: { en: "default", zh: "默认" },
  modalityText: { en: "text", zh: "文本" },
  modalityImage: { en: "image", zh: "图像" },
  modelReasoning: { en: "reasoning", zh: "思考" },

  /* —— 设置菜单 ----------------------------------------------------------- */

  settingsTitle: { en: "Pi Agent Chat: settings", zh: "Pi Agent Chat：设置" },
  settingsProviders: { en: "Providers", zh: "供应商" },
  settingsProvidersDetail: {
    en: "Sign in / configure a model provider",
    zh: "登录 / 配置模型供应商",
  },
  settingsShellPath: { en: "Shell path", zh: "Shell 路径" },
  settingsScopedModels: { en: "Frequently used models", zh: "常用模型" },
  settingsScopedModelsDetail: {
    en: "Choose the models listed first in the model picker",
    zh: "选择模型选择器中优先列出的模型",
  },
  settingsDefaultTools: { en: "Default tools", zh: "默认工具" },
  settingsDefaultToolsDetail: {
    en: "Built-in tools enabled when a session starts",
    zh: "新会话启动时启用的内置工具",
  },
  defaultToolsScopeTitle: { en: "Pi Agent Chat: default tools scope", zh: "Pi Agent Chat：默认工具作用域" },
  defaultToolsScopeUser: { en: "User (global)", zh: "用户（全局）" },
  defaultToolsScopeUserDetail: {
    en: "Applies to every project; written to ~/.pi/agent/settings.json",
    zh: "对所有项目生效；写入 ~/.pi/agent/settings.json",
  },
  defaultToolsScopeWorkspace: { en: "Workspace", zh: "工作区" },
  defaultToolsWorkspaceNotSet: { en: "not set (follows the user setting)", zh: "未设置（沿用用户设置）" },
  defaultToolsTitleUser: { en: "Pi Agent Chat: default tools (user)", zh: "Pi Agent Chat：默认工具（用户）" },
  defaultToolsTitleWorkspace: {
    en: "Pi Agent Chat: default tools (workspace)",
    zh: "Pi Agent Chat：默认工具（工作区）",
  },
  defaultToolsPlaceholder: {
    en: "Check the built-in tools enabled at session start; checking all four restores the default, checking none disables them",
    zh: "勾选会话启动时启用的内置工具；全选即恢复默认，全不选则不启用内置工具",
  },
  defaultToolsWorkspacePlaceholder: {
    en: "Check the built-in tools enabled at session start in this workspace",
    zh: "勾选本工作区会话启动时启用的内置工具",
  },
  defaultToolsResetWorkspace: { en: "Reset workspace override", zh: "清除工作区覆盖" },
  defaultToolsWorkspace: { en: "workspace", zh: "工作区" },
  defaultToolsAll: { en: "all (default)", zh: "全部（默认）" },
  defaultToolsNone: { en: "none (built-in tools off)", zh: "无（不启用内置工具）" },
  toolDescRead: { en: "Read file contents", zh: "读取文件内容" },
  toolDescBash: { en: "Run shell commands", zh: "执行 shell 命令" },
  toolDescEdit: { en: "Edit files with exact replacements", zh: "按精确替换修改文件" },
  toolDescWrite: { en: "Create or overwrite files", zh: "创建或覆写文件" },
  settingsRefreshModels: { en: "Refresh model catalog", zh: "刷新模型列表" },
  settingsRefreshModelsDetail: {
    en: "Re-fetch every provider's model list from the network (retry after a failed refresh)",
    zh: "从网络重新获取各供应商的模型列表（用于刷新失败后重试）",
  },
  settingsHelp: { en: "Command help", zh: "命令帮助" },
  settingsPluginSettings: { en: "Plugin settings", zh: "插件设置" },
  settingsPluginSettingsDetail: {
    en: "Open the VS Code settings for this plugin (subagent, integrated terminal, transcript folding, etc.)",
    zh: "打开本插件的 VS Code 设置（子代理、集成终端、消息折叠等）",
  },
  settingsSectionOptions: { en: "Options (shared with the pi CLI)", zh: "选项（与终端 pi 共用）" },
  settingsOpenFile: { en: "Edit Pi global settings file", zh: "编辑 Pi 全局设置文件" },
  settingsOpenFileDetail: { en: "Edit ~/.pi/agent/settings.json directly", zh: "直接编辑 ~/.pi/agent/settings.json" },
  settingAutoCompact: { en: "Auto-compact", zh: "自动压缩" },
  settingAutoCompactDetail: {
    en: "Automatically compact context when it gets too large",
    zh: "上下文接近上限时自动压缩",
  },
  settingDefaultThinking: { en: "Default thinking level", zh: "默认思考等级" },
  settingDefaultThinkingDetail: {
    en: "Reasoning depth for new sessions (thinking-capable models)",
    zh: "新会话的思考深度（仅支持思考的模型）",
  },
  settingSteeringMode: { en: "Steering mode", zh: "插话模式" },
  settingSteeringModeDetail: {
    en: "How messages sent while streaming are delivered: one at a time, or all at once",
    zh: "运行中发送的消息如何送达：逐条等回复，或一次全部送达",
  },
  settingFollowUpMode: { en: "Follow-up mode", zh: "后续消息模式" },
  settingFollowUpModeDetail: {
    en: "How queued follow-up messages are delivered after the agent finishes",
    zh: "agent 完成后，排队的后续消息如何送达",
  },
  settingProjectTrust: { en: "Default project trust", zh: "默认项目信任" },
  settingProjectTrustDetail: {
    en: "Fallback when no saved trust decision exists for a project",
    zh: "项目没有已保存的信任决定时的默认行为",
  },
  trustAsk: { en: "ask", zh: "询问" },
  trustAlways: { en: "always trust", zh: "总是信任" },
  trustNever: { en: "never trust", zh: "从不信任" },
  settingSkillCommands: { en: "Skill commands", zh: "技能命令" },
  settingSkillCommandsDetail: {
    en: "Register skills as /skill:name commands",
    zh: "把技能注册为 /skill:名称 命令",
  },
  settingRetry: { en: "Auto-retry", zh: "自动重试" },
  settingRetryDetail: {
    en: "Retry failed provider requests automatically",
    zh: "请求失败时自动重试",
  },
  settingTransport: { en: "Transport", zh: "传输方式" },
  settingTransportDetail: {
    en: "Preferred transport for providers that support multiple transports",
    zh: "支持多种传输方式的供应商的首选传输",
  },
  settingHttpIdleTimeout: { en: "HTTP idle timeout", zh: "HTTP 空闲超时" },
  settingHttpIdleTimeoutDetail: {
    en: "Max idle gap while waiting for response data; disable for slow local models",
    zh: "等待响应数据的最大空闲间隔；本地慢模型可禁用",
  },
  settingAutoResizeImages: { en: "Auto-resize images", zh: "自动缩放图片" },
  settingAutoResizeImagesDetail: {
    en: "Resize large images to 2000x2000 max for better model compatibility",
    zh: "大图自动缩到 2000x2000 以内，提升模型兼容性",
  },
  settingBlockImages: { en: "Block images", zh: "阻止图片" },
  settingBlockImagesDetail: {
    en: "Prevent images from being sent to LLM providers",
    zh: "禁止向 LLM 供应商发送图片",
  },
  settingAnthropicWarning: { en: "Anthropic extra usage warning", zh: "Anthropic 额外用量警告" },
  settingAnthropicWarningDetail: {
    en: "Warn when Anthropic subscription auth may use paid extra usage",
    zh: "订阅认证可能产生付费额外用量时警告",
  },
  renameRunningSession: {
    en: "A subagent is writing to this session; rename it after the run finishes.",
    zh: "子代理正在写入该会话，运行结束后再重命名。",
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
    en: "That path does not exist.",
    zh: "该路径不存在。",
  },
  shellPathCleared: {
    en: "shell path reset to system default (applies to new sessions)",
    zh: "shell 路径已恢复系统默认（对新会话生效）",
  },
  defaultToolsWorkspaceReset: {
    en: "workspace default tools override removed; following the user setting (applies to new sessions)",
    zh: "已清除工作区的默认工具覆盖，恢复沿用用户设置（对新会话生效）",
  },

  /* —— 登录 / 登出 --------------------------------------------------------- */

  noLoginProviders: {
    en: "Pi Agent Chat: no login providers available.",
    zh: "Pi Agent Chat：没有可登录的供应商。",
  },
  signInTitle: { en: "Pi Agent Chat: sign in to a provider", zh: "Pi Agent Chat：登录模型供应商" },
  oauthDescription: { en: "OAuth / subscription", zh: "OAuth / 订阅" },
  apiKeyDescription: { en: "API key", zh: "API key" },
  oauthLabel: { en: "OAuth", zh: "OAuth" },
  // 标记访问基于付费订阅计划的供应商。
  subscriptionLabel: { en: "subscription", zh: "订阅制" },
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

  /* —— 自定义供应商（models.json）--------------------------------------------- */

  customProviderLabel: {
    en: "$(edit) Custom provider (models.json)...",
    zh: "$(edit) 自定义供应商（models.json）…",
  },
  customProviderDetail: {
    en: "Add your own endpoint, models and API key by editing the shared models.json (a template is inserted when you have none configured yet)",
    zh: "编辑共享的 models.json，自定义接入地址、模型与 API key（尚无供应商配置时会插入一份模板）",
  },
  customProviderOpened: {
    en: "Edit models.json and save it - Pi Agent Chat reloads the file on save.",
    zh: "编辑 models.json 并保存 — 保存后 Pi Agent Chat 会自动重新加载。",
  },
  /** 向尚无供应商的 models.json 插入了供应商模板。 */
  customProviderAppended: {
    en: "A new provider template was inserted at the top of models.json (not saved yet - undo with Ctrl+Z). Edit it and save; Pi Agent Chat reloads the file on save.",
    zh: "已在 models.json 顶部插入一份新的供应商模板（尚未保存，Ctrl+Z 可撤销）。改完保存即可 — 保存后 Pi Agent Chat 会自动重新加载。",
  },
  deleteCustomProvider: { en: "Remove from models.json", zh: "从 models.json 中删除" },
  deleteCustomProviderAction: { en: "Remove", zh: "删除" },
  deleteCustomProviderDetail: {
    en: "Only this entry in ~/.pi/agent/models.json is removed. Credentials stored by signing in are kept; use logout for those.",
    zh: "只删除 ~/.pi/agent/models.json 中的这一项配置。通过登录保存的凭据不受影响，那些请用登出移除。",
  },
  /** models.json 没有任何配置（空或 `{}`），pi 不接受；已写回空 `providers`。 */
  modelsConfigRepaired: {
    en: 'models.json held no configuration (it was empty or just {}), which pi rejects, so { "providers": {} } was written back - the form pi reads as "nothing configured".',
    zh: 'models.json 里没有任何配置（空文件或只有 {}），pi 不接受这种状态，已写入 { "providers": {} } — 这才是 pi 能读懂的「没有自定义配置」。',
  },
  /** 手动刷新模型目录期间的进度标题。 */
  modelsRefreshing: {
    en: "Pi Agent Chat: refreshing model catalogs…",
    zh: "Pi Agent Chat：正在刷新模型列表…",
  },
  /** 手动刷新被超时中止。 */
  modelsRefreshTimedOut: {
    en: "model catalog refresh timed out; showing cached models",
    zh: "模型列表刷新超时；当前显示缓存的列表",
  },

  /* —— 会话树 --------------------------------------------------------------- */

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

  /* —— 内置命令 ------------------------------------------------------------- */

  compacting: { en: "compacting context...", zh: "正在压缩上下文……" },
  resourcesReloaded: {
    en: "reloaded extensions, skills, prompts and context files",
    zh: "已重新加载扩展、技能、提示词与上下文文件",
  },
  noAssistantMessage: { en: "no assistant message to copy", zh: "没有可复制的助手消息" },
  copiedLastMessage: { en: "last assistant message copied", zh: "已复制最后一条助手消息" },

  /**
   * 子代理设置已改，屏幕上的会话保持原工具集。
   *
   * 工具集在会话构建时固定，`reload()` 也保留宿主 `customTools`，改动到不了
   * 进行中的对话——静默重建等于扔掉那个对话。但每次会话*替换*都会重建工具
   * 集，出路不限于新开对话。
   */
  subagentSettingChanged: {
    en: "Subagent settings changed. This session keeps its current tools; the new values take effect after you start or switch to another session (its history is kept), or reload the window.",
    zh: "子代理设置已更改。当前会话仍沿用原有工具；新建会话、切换到其他会话（历史不丢）或重载窗口后生效。",
  },

  /**
   * 同一变更，因会话还是空的而立即应用。
   *
   * 重建空会话零损失，且它是唯一没有出口的状态：「新建」按钮在空会话上本来
   * 就禁用，否则只剩重载窗口一条路。
   */
  subagentSettingApplied: {
    en: "Subagent settings changed. This session was still empty, so it was rebuilt and the new values are already in effect.",
    zh: "子代理设置已更改。当前会话还是空的，已重建并立即生效。",
  },

  /**
   * 终端工具的同一对文案。不用共享措辞：消息必须点名用户刚改的那个工具，
   * 否则读起来像在报告别的东西。
   */
  terminalSettingChanged: {
    en: "Terminal tool settings changed. This session keeps its current tools; the new values take effect after you start or switch to another session (its history is kept), or reload the window.",
    zh: "终端工具设置已更改。当前会话仍沿用原有工具；新建会话、切换到其他会话（历史不丢）或重载窗口后生效。",
  },
  terminalSettingApplied: {
    en: "Terminal tool settings changed. This session was still empty, so it was rebuilt and the new values are already in effect.",
    zh: "终端工具设置已更改。当前会话还是空的，已重建并立即生效。",
  },

  // 填充 `subagentModelFallback` 的来源槽位。
  subagentModelSourceSetting: {
    en: "the default subagent model setting",
    zh: "子代理默认模型设置",
  },
  /** 配置的模型都没解析出来时，填充 `subagentModelFallback` 的模型槽位。 */
  subagentModelFallbackParent: {
    en: "the parent session's model",
    zh: "父会话的模型",
  },

  /* —— 扩展 UI 钩子 --------------------------------------------------------- */

  confirmYes: { en: "Yes", zh: "确定" },

  /* —— 资源清单 ------------------------------------------------------------- */

} satisfies Record<string, LocalizedText>;
