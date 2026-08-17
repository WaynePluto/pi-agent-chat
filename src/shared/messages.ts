/**
 * Localized strings shown by the **extension host**: native dialogs, QuickPick
 * titles and the status notices it pushes into the transcript.
 *
 * Kept next to the webview dictionary so both sides stay worded consistently;
 * the entries the composer's model picker also renders are pulled straight
 * from here by `webview/i18n.ts`. Like `protocol.ts`, this file must stay
 * dependency-free — the webview bundle imports it too and cannot pull in
 * Node-only code.
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

  /** Error notice when new / resume / tree is attempted mid-run. */
  singleSessionGuard: {
    en: "Pi Agent Chat is single-session: stop the current run before switching or starting a session.",
    zh: "Pi Agent Chat 仅支持单会话模式：请先停止当前会话的运行，再切换或新建会话。",
  },

  /* Retry -------------------------------------------------------------- */

  /**
   * Closing notice on a turn whose request never came back, carrying the retry
   * action. Deliberately neutral about the cause: it covers a connection error
   * automatic retry gave up on, a timeout with retry switched off, and an
   * error that was never retriable in the first place.
   */
  retryInterrupted: {
    en: "The last request did not complete, so no reply arrived.",
    zh: "上一次请求没有完成，未收到回复。",
  },

  /** The retry action was clicked after the session moved past the failure. */
  retryUnavailable: {
    en: "Nothing to retry: this session has moved on since that request failed. Send a message to continue.",
    zh: "没有可重试的请求：该请求失败后会话已经继续了。发送一条消息即可继续。",
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

  /* Model / thinking level --------------------------------------------- */

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
  /** Composer menu row that hands over to the full native model picker. */
  otherModels: { en: "Other models...", zh: "其他模型…" },
  defaultModelMarker: { en: "default", zh: "默认" },
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
  settingsSubagent: { en: "Subagent", zh: "子代理" },
  settingsSubagentDetail: {
    en: "Open the VS Code settings for the subagent tool (this window only, not shared with the pi CLI)",
    zh: "打开 subagent 工具的 VS Code 设置（仅本插件，不与终端 pi 共用）",
  },
  settingsSectionOptions: { en: "Options (shared with the pi CLI)", zh: "选项（与终端 pi 共用）" },
  settingsOpenFile: { en: "Open settings file", zh: "打开设置文件" },
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

  /* Login / logout ------------------------------------------------------ */

  noLoginProviders: {
    en: "Pi Agent Chat: no login providers available.",
    zh: "Pi Agent Chat：没有可登录的供应商。",
  },
  signInTitle: { en: "Pi Agent Chat: sign in to a provider", zh: "Pi Agent Chat：登录模型供应商" },
  oauthDescription: { en: "OAuth / subscription", zh: "OAuth / 订阅" },
  apiKeyDescription: { en: "API key", zh: "API key" },
  oauthLabel: { en: "OAuth", zh: "OAuth" },
  /** Marks a provider whose access is backed by a paid subscription plan. */
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

  /* Custom providers (models.json) -------------------------------------- */

  customProviderLabel: {
    en: "$(edit) Custom provider (models.json)...",
    zh: "$(edit) 自定义供应商（models.json）…",
  },
  customProviderDetail: {
    en: "Add your own endpoint, models and API key by editing the shared models.json (a fresh template is inserted each time)",
    zh: "编辑共享的 models.json，自定义接入地址、模型与 API key（每次都会插入一份新模板）",
  },
  customProviderOpened: {
    en: "Edit models.json and save it - Pi Agent Chat reloads the file on save.",
    zh: "编辑 models.json 并保存 — 保存后 Pi Agent Chat 会自动重新加载。",
  },
  /** A second (third, ...) provider template was inserted into an existing models.json. */
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
  /** models.json held no configuration (empty, or `{}`), which pi rejects; an empty `providers` map was written. */
  modelsConfigRepaired: {
    en: 'models.json held no configuration (it was empty or just {}), which pi rejects, so { "providers": {} } was written back - the form pi reads as "nothing configured".',
    zh: 'models.json 里没有任何配置（空文件或只有 {}），pi 不接受这种状态，已写入 { "providers": {} } — 这才是 pi 能读懂的「没有自定义配置」。',
  },
  /** Progress title while a manual catalogue refresh is running. */
  modelsRefreshing: {
    en: "Pi Agent Chat: refreshing model catalogs…",
    zh: "Pi Agent Chat：正在刷新模型列表…",
  },
  /** Manual catalogue refresh was aborted by its timeout. */
  modelsRefreshTimedOut: {
    en: "model catalog refresh timed out; showing cached models",
    zh: "模型列表刷新超时；当前显示缓存的列表",
  },

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
  resourcesReloaded: {
    en: "reloaded extensions, skills, prompts and context files",
    zh: "已重新加载扩展、技能、提示词与上下文文件",
  },
  noAssistantMessage: { en: "no assistant message to copy", zh: "没有可复制的助手消息" },
  copiedLastMessage: { en: "last assistant message copied", zh: "已复制最后一条助手消息" },

  /**
   * A subagent setting changed, and the session on screen keeps its tool set.
   *
   * A session's tool set is fixed when the session is built, and `reload()`
   * keeps the host's `customTools`, so the change cannot reach a conversation
   * already in progress — and silently rebuilding it would throw that
   * conversation away. Every session *replacement* does rebuild the tool set,
   * though, so the way out is not limited to starting a new conversation.
   */
  subagentSettingChanged: {
    en: "Subagent settings changed. This session keeps its current tools; the new values take effect after you start or switch to another session (its history is kept), or reload the window.",
    zh: "子代理设置已更改。当前会话仍沿用原有工具；新建会话、切换到其他会话（历史不丢）或重载窗口后生效。",
  },

  /**
   * The same change, applied at once because the session was still empty.
   *
   * Rebuilding an empty session costs nothing, and it is the one state with no
   * other way out: the "new session" button is disabled on an already-empty
   * session, so the alternative would be reloading the window.
   */
  subagentSettingApplied: {
    en: "Subagent settings changed. This session was still empty, so it was rebuilt and the new values are already in effect.",
    zh: "子代理设置已更改。当前会话还是空的，已重建并立即生效。",
  },

  /** Fills the source slot of `subagentModelFallback`. */
  subagentModelSourceSetting: {
    en: "the default subagent model setting",
    zh: "子代理默认模型设置",
  },
  /** Fills the model slot of `subagentModelFallback` when nothing configured resolved. */
  subagentModelFallbackParent: {
    en: "the parent session's model",
    zh: "父会话的模型",
  },

  /* Extension UI hooks -------------------------------------------------- */

  confirmYes: { en: "Yes", zh: "确定" },

  /* Resource listing --------------------------------------------------- */

} satisfies Record<string, LocalizedText>;

/**
 * One provider entry for `~/.pi/agent/models.json`, indented for the
 * `"providers"` object and carrying a comment per field.
 *
 * This is the unit the sidebar writes: it seeds the whole file when models.json
 * is empty (`modelsConfigTemplate` below) and is inserted on its own when the
 * file already defines providers. pi parses the file with `stripJsonComments`,
 * so the comments are part of the supported format and carry the documentation
 * this flow would otherwise need a wizard for.
 *
 * `apiKey` is a literal placeholder rather than `$MY_API_KEY`: pi only offers a
 * provider's models once its credential resolves, so an unset variable would
 * make the seeded example invisible in the picker. A literal value keeps the
 * no-login case (local servers that ignore the key) working out of the box,
 * which is what `docs/models.md` recommends for Ollama/vLLM/LM Studio.
 */
export const modelsConfigProviderEntry: LocalizedText = {
  en: `    // Provider id: shown next to every model of this provider. Reusing a
    // built-in id (anthropic, openai, ...) overrides that provider instead.
    "my-provider": {
      // Base URL of the endpoint, e.g. http://localhost:11434/v1 for Ollama.
      "baseUrl": "https://api.example.com/v1",
      // Request format spoken by the endpoint:
      // openai-completions | openai-responses | anthropic-messages | google-generative-ai
      "api": "openai-completions",
      // Required for the models to be offered at all - pi hides the models of a
      // provider without a credential. Your real key, any placeholder when the
      // server ignores it, "$ENV_VAR", or "!shell command". No sign-in involved.
      "apiKey": "not-needed",
      // Compatibility switches. Servers that reject the "developer" role or
      // "reasoning_effort" (Ollama, vLLM, SGLang, ...) need these two:
      // "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [
        {
          // Model id sent to the API - the only required field.
          "id": "my-model",
          // Human-readable label, used for matching and as detail text.
          "name": "My Model",
          // Whether the model supports extended thinking.
          "reasoning": false,
          // Accepted input: ["text"] or ["text", "image"].
          "input": ["text"],
          // Context window, in tokens.
          "contextWindow": 128000,
          // Upper bound on output tokens per response.
          "maxTokens": 16384
        }
      ]
    }`,
  zh: `    // 供应商 id：会显示在该供应商的每个模型旁边。写成内置 id
    // （anthropic、openai 等）则变成覆盖那个内置供应商的配置。
    "my-provider": {
      // 接入地址（base URL），例如 Ollama 是 http://localhost:11434/v1。
      "baseUrl": "https://api.example.com/v1",
      // 该接口使用的请求格式：
      // openai-completions | openai-responses | anthropic-messages | google-generative-ai
      "api": "openai-completions",
      // 必须有，否则模型根本不会出现在选择器里 — pi 会隐藏没有凭据的供应商。
      // 可填真实 key；服务端不校验时随便填个占位值即可。也支持 "$环境变量"
      // 与 "!shell 命令"；整个过程不涉及登录流程。
      "apiKey": "not-needed",
      // 兼容性开关。不支持 "developer" 角色或 "reasoning_effort" 的服务
      // （Ollama、vLLM、SGLang 等）需要这两项：
      // "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [
        {
          // 传给接口的模型 id — 唯一必填的字段。
          "id": "my-model",
          // 供人阅读的名称，用于模型匹配与详情行展示。
          "name": "My Model",
          // 该模型是否支持深度思考。
          "reasoning": false,
          // 接受的输入类型：["text"] 或 ["text", "image"]。
          "input": ["text"],
          // 上下文窗口大小（token 数）。
          "contextWindow": 128000,
          // 单次回复的最大输出 token 数。
          "maxTokens": 16384
        }
      ]
    }`,
};

/** Provider id used by `modelsConfigProviderEntry`; replaced when it is already taken. */
export const modelsConfigTemplateProviderId = "my-provider";

/** Whole-file seed for an empty `~/.pi/agent/models.json`. */
export const modelsConfigTemplate: LocalizedText = {
  en: `// Custom providers and models for pi - shared with the pi CLI.
// Reference: https://github.com/earendil-works/pi/blob/main/docs/models.md
// Replace the example below with your own endpoint, then save this file.
{
  "providers": {
${modelsConfigProviderEntry.en}
  }
}
`,
  zh: `// pi 的自定义供应商与模型配置 - 与 pi CLI 共用这一份文件。
// 完整说明：https://github.com/earendil-works/pi/blob/main/docs/models.md
// 把下面的示例改成你自己的配置，然后保存该文件。
{
  "providers": {
${modelsConfigProviderEntry.zh}
  }
}
`,
};

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
  /** An extension handler threw; mirrors what the CLI prints via `onError`. */
  extensionHandlerFailed: {
    en: (name: string, event: string, reason: string) => `Extension ${name} failed on "${event}": ${reason}`,
    zh: (name: string, event: string, reason: string) => `扩展 ${name} 在处理 "${event}" 事件时出错：${reason}`,
  },
  /**
   * A model the user configured for a subagent could not be resolved.
   *
   * Shown to the user only: the parent agent neither chose that model nor can
   * correct it, so its report says nothing about the substitution.
   */
  subagentModelFallback: {
    en: (lane: string, requested: string, source: string, using: string) =>
      `Subagent "${lane}": model "${requested}" from ${source} is not available; running on ${using} instead.`,
    zh: (lane: string, requested: string, source: string, using: string) =>
      `子代理“${lane}”：${source}中的模型“${requested}”不可用，改用 ${using} 运行。`,
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
  /**
   * `CredentialSynchronizationError`: the credential change itself succeeded,
   * only the local model/auth snapshot could not be refreshed afterwards.
   */
  credentialSyncFailed: {
    en: (provider: string, reason: string) =>
      `Pi Agent Chat: credentials for ${provider} were saved, but refreshing the local model list failed — ${reason}. The model list may be stale until you reload.`,
    zh: (provider: string, reason: string) =>
      `Pi Agent Chat：${provider} 的凭据已保存，但本地模型列表刷新失败 — ${reason}。重新加载前模型列表可能不是最新的。`,
  },
  /** `ModelsRefreshResult.errors`: some providers failed their catalogue refresh. */
  modelRefreshFailed: {
    en: (providers: string, reason: string) =>
      `Pi Agent Chat: could not refresh models for ${providers} — ${reason}`,
    zh: (providers: string, reason: string) => `Pi Agent Chat：无法刷新 ${providers} 的模型列表 — ${reason}`,
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
  sessionRenamed: {
    en: (name: string) => `session renamed to "${name}"`,
    zh: (name: string) => `会话已重命名为“${name}”`,
  },
  favoriteModelsSaved: {
    en: (count: number) => `${count} frequently used model(s) saved to settings`,
    zh: (count: number) => `已保存 ${count} 个常用模型到设置`,
  },
  defaultToolsSaved: {
    en: (tools: string) => `default tools: ${tools} (applies to new sessions)`,
    zh: (tools: string) => `默认工具已设置为 ${tools}（对新会话生效）`,
  },
  defaultToolsSavedWorkspace: {
    en: (tools: string) => `default tools (workspace): ${tools} (applies to new sessions)`,
    zh: (tools: string) => `默认工具（工作区）已设置为 ${tools}（对新会话生效）`,
  },
  defaultToolsScopeWorkspaceDetail: {
    en: (path: string) => `Overrides the user setting in this workspace only; written to ${path}`,
    zh: (path: string) => `仅覆盖本工作区的用户设置；写入 ${path}`,
  },
  defaultToolsResetDetail: {
    en: (path: string) => `Remove defaultTools from ${path}; this workspace follows the user setting again`,
    zh: (path: string) => `从 ${path} 移除 defaultTools；本工作区恢复沿用用户设置`,
  },
  favoriteModelSet: {
    en: (reference: string, favorite: boolean) =>
      favorite ? `${reference} added to frequently used models` : `${reference} removed from frequently used models`,
    zh: (reference: string, favorite: boolean) =>
      favorite ? `已将 ${reference} 设为常用模型` : `已将 ${reference} 移出常用模型`,
  },
  defaultModelSet: {
    en: (reference: string) => `default model set to ${reference}`,
    zh: (reference: string) => `默认模型已设为 ${reference}`,
  },
  settingChanged: {
    en: (label: string, value: string) => `${label}: ${value}`,
    zh: (label: string, value: string) => `${label}：${value}`,
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
  /** `~/.pi/agent/models.json` was saved and reloaded. */
  modelsConfigReloaded: {
    en: (count: number) => `models.json reloaded: ${count} model(s) available`,
    zh: (count: number) => `models.json 已重新加载：当前有 ${count} 个可用模型`,
  },
  /** Manual catalogue refresh finished without provider errors. */
  modelsRefreshed: {
    en: (count: number) => `model catalogs refreshed: ${count} model(s) available`,
    zh: (count: number) => `模型列表已刷新：当前有 ${count} 个可用模型`,
  },
  /** Models the edit added that can actually be selected. */
  modelsConfigAdded: {
    en: (references: string) => `new models available: ${references}`,
    zh: (references: string) => `新增可用模型：${references}`,
  },
  /**
   * Models the edit added that stay hidden: pi only offers a provider's models
   * once its credential resolves, so even a keyless endpoint needs some
   * `apiKey` value.
   */
  modelsConfigUnauthenticated: {
    en: (provider: string, count: number) =>
      `"${provider}": ${count} model(s) loaded but not offered - pi hides the models of a provider without a credential. Set any "apiKey" value on it in models.json (a placeholder is enough when the server ignores it; a "$VAR" must resolve in the VS Code process), or sign in to that provider.`,
    zh: (provider: string, count: number) =>
      `供应商 “${provider}” 的 ${count} 个模型已加载，但不会出现在模型选择器里 — pi 会隐藏没有凭据的供应商的模型。请在 models.json 里给它填一个 “apiKey”（服务端不校验时占位值即可；写 “$变量” 时它必须在 VS Code 进程中能解析），或登录该供应商。`,
  },
  /** `ModelRuntime.getError()`: models.json failed to parse/validate, or a provider could not be composed. */
  modelsConfigError: {
    en: (reason: string) => `models.json error: ${reason}`,
    zh: (reason: string) => `models.json 错误：${reason}`,
  },
  deleteCustomProviderConfirm: {
    en: (provider: string) => `Remove the models.json configuration for "${provider}"?`,
    zh: (provider: string) => `删除 models.json 中 “${provider}” 的配置？`,
  },
  customProviderDeleted: {
    en: (provider: string) => `Pi Agent Chat: removed "${provider}" from models.json.`,
    zh: (provider: string) => `Pi Agent Chat：已从 models.json 中删除 “${provider}”。`,
  },
  deleteCustomProviderFailed: {
    en: (provider: string, reason: string) => `Pi Agent Chat: could not remove "${provider}" from models.json - ${reason}`,
    zh: (provider: string, reason: string) => `Pi Agent Chat：无法从 models.json 中删除 “${provider}” — ${reason}`,
  },
};
