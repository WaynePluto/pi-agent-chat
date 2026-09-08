/**
 * 参数化消息模板（`sharedTemplates`）。属于 `shared/messages` 模块——模块契约
 * （零依赖；webview 也会导入）见 `../messages.ts`。
 */
/** 带插值的文案；两种语言必须接受相同参数。 */
export const sharedTemplates = {
  /** 附件图片发送前被重新编码（见 `agent/images.ts`）。 */
  imageConverted: {
    en: (from: string, to: string) => `[Image converted from ${from} to ${to}.]`,
    zh: (from: string, to: string) => `[图片已从 ${from} 转换为 ${to}。]`,
  },
  /** 发消息时折叠在 `@path` 引用行之前的提示前缀。 */
  referencedFilesHeader: {
    en: (lines: string) =>
      `Referenced project paths (relative to the workspace root; inspect files with read and directories with ls/find/read; directory contents are not attached automatically):\n${lines}`,
    zh: (lines: string) =>
      `引用的项目路径（相对于工作区根目录；请使用 read 查看文件，使用 ls/find/read 查看目录；目录内容不会自动附加）：\n${lines}`,
  },
  diffEditorTitle: {
    en: (name: string) => `${name} (pi edit)`,
    zh: (name: string) => `${name}（pi 修改）`,
  },
  /** 扩展 handler 抛错；与 CLI 经 `onError` 打印的对齐。 */
  extensionHandlerFailed: {
    en: (name: string, event: string, reason: string) => `Extension ${name} failed on "${event}": ${reason}`,
    zh: (name: string, event: string, reason: string) => `扩展 ${name} 在处理 "${event}" 事件时出错：${reason}`,
  },
  /**
   * 用户为子代理配置的模型解析不出来。
   *
   * 只给用户看：父代理没选它也改不了它，汇报里对替换只字不提。
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
   * `CredentialSynchronizationError`：凭据变更本身成功，只是之后本地模型/
   * 认证快照刷新失败。
   */
  credentialSyncFailed: {
    en: (provider: string, reason: string) =>
      `Pi Agent Chat: credentials for ${provider} were saved, but refreshing the local model list failed — ${reason}. The model list may be stale until you reload.`,
    zh: (provider: string, reason: string) =>
      `Pi Agent Chat：${provider} 的凭据已保存，但本地模型列表刷新失败 — ${reason}。重新加载前模型列表可能不是最新的。`,
  },
  /** `ModelsRefreshResult.errors`：部分供应商目录刷新失败。 */
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
  /** 模型的 QuickPick 详情行：输入模态、上下文窗口、最大输出。 */
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
  /** `~/.pi/agent/models.json` 已保存并重载。 */
  modelsConfigReloaded: {
    en: (count: number) => `models.json reloaded: ${count} model(s) available`,
    zh: (count: number) => `models.json 已重新加载：当前有 ${count} 个可用模型`,
  },
  // 手动刷新完成且无供应商错误。
  modelsRefreshed: {
    en: (count: number) => `model catalogs refreshed: ${count} model(s) available`,
    zh: (count: number) => `模型列表已刷新：当前有 ${count} 个可用模型`,
  },
  /** 编辑后新增、确实可选的模型。 */
  modelsConfigAdded: {
    en: (references: string) => `new models available: ${references}`,
    zh: (references: string) => `新增可用模型：${references}`,
  },
  /** 编辑后新增但保持隐藏的模型：凭据解析不出就不展示，无 key 端点也得填个 `apiKey` 值。 */
  modelsConfigUnauthenticated: {
    en: (provider: string, count: number) =>
      `"${provider}": ${count} model(s) loaded but not offered - pi hides the models of a provider without a credential. Set any "apiKey" value on it in models.json (a placeholder is enough when the server ignores it; a "$VAR" must resolve in the VS Code process), or sign in to that provider.`,
    zh: (provider: string, count: number) =>
      `供应商 “${provider}” 的 ${count} 个模型已加载，但不会出现在模型选择器里 — pi 会隐藏没有凭据的供应商的模型。请在 models.json 里给它填一个 “apiKey”（服务端不校验时占位值即可；写 “$变量” 时它必须在 VS Code 进程中能解析），或登录该供应商。`,
  },
  /** `ModelRuntime.getError()`：models.json 解析/校验失败，或供应商无法组装。 */
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
