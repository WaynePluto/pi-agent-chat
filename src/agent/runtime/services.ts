import {
  createAgentSessionServices,
  resolveModelScopeWithDiagnostics,
  type AgentSessionServices,
  type ScopedModel,
} from "@earendil-works/pi-coding-agent";

/**
 * 返回注册了 `toolName` 工具的已加载 pi 扩展的路径。
 *
 * 插件为自有工具认领的名字对扩展一律屏蔽，与开关无关：一个名字在窗口里只能
 * 有一个含义。开关开时靠 SDK 注册表的覆盖语义取胜（`_refreshToolRegistry()`），
 * 关时经 `excludeTools` 排除。只按工具名匹配，不认扩展身份、不看实现。
 * 可在 `createAgentSessionServices()` 后立即调用（内部已 await reload）。
 */
export function findShadowedExtensionTool(services: AgentSessionServices, toolName: string): string | undefined {
  try {
    const { extensions } = services.resourceLoader.getExtensions();
    return extensions.find((extension) => extension.tools.has(toolName))?.path;
  } catch {
    return undefined;
  }
}

/**
 * 构建子代理子会话运行的 services。
 *
 * 子会话绝不能复用父会话的 services，并行子会话之间也不能：扩展按
 * `ResourceLoader` 加载一次，同 loader 构建的会话共享扩展 runtime，第二个
 * 活会话会把所有扩展的 `pi.*` 劫持到自己身上，其 dispose 又让共享 runtime
 * 永久 stale 且无法复位——私有 loader 才是隔离的本义。`modelRuntime` /
 * `settingsManager` 有意共享：不绑定会话，带着 auth 与 project-trust 决定，
 * 扩展工厂重跑的重复注册按 SDK 的 merge 语义合并。
 */
export async function createIsolatedServices(
  parent: AgentSessionServices,
  cwd = parent.cwd,
): Promise<AgentSessionServices> {
  return await createAgentSessionServices({
    cwd,
    agentDir: parent.agentDir,
    modelRuntime: parent.modelRuntime,
    settingsManager: parent.settingsManager,
  });
}

/** 历史遗留的任务专用名；所有活子会话仍走这条路径。 */
export async function createSubagentServices(parent: AgentSessionServices): Promise<AgentSessionServices> {
  return await createIsolatedServices(parent);
}

/**
 * 按与 CLI `--models` 相同的匹配规则，将共享 `enabledModels` 模式解析到已认证
 * 的模型目录。
 */
export async function resolveScopedModels(
  services: AgentSessionServices,
  log: (message: string) => void,
  signal?: AbortSignal,
): Promise<ScopedModel[]> {
  const patterns = services.settingsManager.getEnabledModels();
  if (!patterns?.length) return [];
  const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, services.modelRuntime, { signal });
  for (const diagnostic of diagnostics) {
    log(`[${diagnostic.type}] ${diagnostic.message}`);
  }
  return scopedModels;
}
