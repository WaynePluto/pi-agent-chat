import * as vscode from "vscode";
import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import {
  AgentSessionRuntime,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionError,
  type ExtensionCommandContextActions,
  getAgentDir,
  type ScopedModel,
} from "@earendil-works/pi-coding-agent";
import { SubagentCoordinator, SUBAGENT_TOOL } from "../subagent.js";
import { readSubagentConfig, readTerminalConfig, type SubagentConfig, type TerminalConfig } from "../config.js";
import { configureHttpDispatcher } from "../http.js";
import { VsCodeTerminalPool, VSCODE_TERMINAL_TOOL } from "../vscode-terminal.js";
import { createSessionManager } from "./startup.js";
import { createIsolatedServices, createSubagentServices, findShadowedExtensionTool, resolveScopedModels } from "./services.js";
import { createVsCodeExtensionUiContext } from "./extension-ui.js";
import type {
  ExtensionNotice,
  ExtensionStatusUpdate,
  ExtensionWidgetUpdate,
  PiRuntimeOptions,
  SessionLifecycleSink,
  ToolSetupRef,
} from "./types.js";

/**
 * SDK `AgentSessionRuntime` 的薄封装。
 *
 * 负责会话替换（new / resume），并在 `runtime.session` 被换掉时按 SDK 要求
 * 重新 bind 扩展与事件订阅。
 */
export class PiRuntime implements vscode.Disposable {
  private constructor(
    readonly runtime: AgentSessionRuntime,
    readonly subagents: SubagentCoordinator,
    readonly terminals: VsCodeTerminalPool,
    /** dispose 时中止；取消本 runtime 发起的所有 auth/模型调用。 */
    private readonly lifetime: AbortController,
    private readonly log: (message: string) => void,
    /** 由会话工厂在每次（重）建时写入；见 `shadowedSubagentExtension`。 */
    private readonly toolSetupRef: ToolSetupRef,
    private readonly openClaimRedirect?: (sessionFile: string) => boolean | Promise<boolean>,
  ) {}

  /**
   * 在本宿主被屏蔽 `subagent` 工具的 pi 扩展路径。只用于新会话提示——工具集
   * 本身在会话工厂里决定。services 重建（即换有效 cwd）时重新求值，项目本地
   * 的扩展也能被捕捉到。
   */
  get shadowedSubagentExtension(): string | undefined {
    return this.toolSetupRef.shadowedSubagent;
  }

  /**
   * 本宿主的 `subagent` 工具是否属于*这个*会话的工具集。
   *
   * 从会话工厂而非设置读取：工具集在会话构建时固定，中途改设置只落到下一个
   * 会话，提示必须描述用户实际所在的会话。
   */
  get subagentEnabled(): boolean {
    return this.toolSetupRef.subagent.enabled;
  }

  /**
   * 本会话工具集构建所用的子代理配置。
   *
   * 设置变更的比较对象：要紧的不是设置现在说什么，而是它是否仍与屏幕上会话
   * 的装配一致。
   */
  get builtSubagentConfig(): SubagentConfig {
    return this.toolSetupRef.subagent;
  }

  /**
   * 在本宿主被屏蔽 `vscode_terminal` 工具的 pi 扩展路径。规则与机制同上面的
   * subagent：插件认领的每个工具名字都归插件所有。
   */
  get shadowedTerminalExtension(): string | undefined {
    return this.toolSetupRef.shadowedTerminal;
  }

  /** 本宿主的终端工具是否属于*这个*会话的工具集。 */
  get terminalEnabled(): boolean {
    return this.toolSetupRef.terminal.enabled;
  }

  /** 本会话工具集构建所用的终端配置。 */
  get builtTerminalConfig(): TerminalConfig {
    return this.toolSetupRef.terminal;
  }

  /** 由 `ChatBridge` 注入；把扩展通知路由到 transcript。 */
  private extensionNotice?: (session: AgentSession, notice: ExtensionNotice) => void;

  // 由 `ChatBridge` 注入；把扩展运行时错误路由到 transcript。
  private extensionError?: (session: AgentSession, error: ExtensionError) => void;

  /** 由 `ChatBridge` 注入；把 `ctx.ui.setStatus` 路由到状态行。 */
  private extensionStatus?: (session: AgentSession, update: ExtensionStatusUpdate) => void;

  /** 由 `ChatBridge` 注入；把 `ctx.ui.setWidget` 路由到 composer 边缘。 */
  private extensionWidget?: (session: AgentSession, update: ExtensionWidgetUpdate) => void;

  // 由 `ChatBridge` 注入；见 `SessionLifecycleSink`。
  private lifecycle?: SessionLifecycleSink;

  /**
   * 本封装自己正在驱动会话替换时为真。
   *
   * 宿主发起的替换会自行 re-attach 视图，rebind 钩子须让路；扩展发起的
   * （`ctx.newSession()` 等）完全在 SDK 内完成，只有这条钩子能感知。
   */
  private replacingSession = false;

  static async create(options: PiRuntimeOptions): Promise<PiRuntime> {
    const { cwd, log } = options;
    const subagents = new SubagentCoordinator(log);
    const lifetime = new AbortController();
    const toolSetup: ToolSetupRef = { subagent: readSubagentConfig(cwd), terminal: readTerminalConfig(cwd) };
    // 显式标注：pool 会向 wrapper 索要当前 cwd，而 wrapper 持有 pool，不标注
    // 两者会互相推断成 `any`。
    const terminals: VsCodeTerminalPool = new VsCodeTerminalPool(() => wrapper.cwd, log);

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: effectiveCwd, sessionManager, sessionStartEvent }) => {
      // modelRuntimeSignal：启动中途关闭视图时取消创建期的凭据恢复与可用性探测。
      const services = options.sharedServices
        ? await createIsolatedServices(options.sharedServices, effectiveCwd)
        : await createAgentSessionServices({ cwd: effectiveCwd, modelRuntimeSignal: lifetime.signal });
      toolSetup.shadowedSubagent = findShadowedExtensionTool(services, SUBAGENT_TOOL);
      toolSetup.shadowedTerminal = findShadowedExtensionTool(services, VSCODE_TERMINAL_TOOL);
      for (const [name, path] of [
        [SUBAGENT_TOOL, toolSetup.shadowedSubagent],
        [VSCODE_TERMINAL_TOOL, toolSetup.shadowedTerminal],
      ] as const) {
        if (path) log(`shadowing the ${name} tool registered by extension ${path}: this window owns that name`);
      }
      // 按会话读取而非启动时读一次：工具集在会话构建时固定，改过的设置正好
      // 落在这里生效。
      const subagentConfig = readSubagentConfig(effectiveCwd);
      toolSetup.subagent = subagentConfig;
      const terminalConfig = readTerminalConfig(effectiveCwd);
      toolSetup.terminal = terminalConfig;
      log(
        subagentConfig.enabled
          ? `subagent enabled (max ${subagentConfig.maxSubagents}${subagentConfig.defaultModel ? `, model ${subagentConfig.defaultModel}` : ""})`
          : "subagent disabled",
      );
      log(
        terminalConfig.enabled
          ? `vscode_terminal enabled (max ${terminalConfig.maxTerminals} terminals)`
          : "vscode_terminal disabled",
      );
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          // 本扩展在 pi 自带工具之外仅有的两个工具，且仅在用户开启时注入；
          // agent 其余可调用的工具都来自 pi 或 pi 扩展。
          // pi 扩展位于 `~/.pi/agent/extensions/`，与 CLI 共享。
          customTools: [
            ...(subagentConfig.enabled ? [subagents.createTool(subagentConfig)] : []),
            ...(terminalConfig.enabled ? [terminals.createTool(terminalConfig)] : []),
          ],
          // 两个名字在任何开关态下都归本窗口：开启时无需排除——SDK 注册表让
          // custom tool 覆盖同名扩展工具（`_refreshToolRegistry()`），模型解析
          // 该名字永远拿到本窗口的工具；关闭时经 `excludeTools` 把名字整个
          // 排除。排除集与 custom tools 都持久化在会话上，`/reload` 后不变。
          excludeTools: [
            ...(subagentConfig.enabled ? [] : [SUBAGENT_TOOL]),
            ...(terminalConfig.enabled ? [] : [VSCODE_TERMINAL_TOOL]),
          ],
          scopedModels: await resolveScopedModels(services, log, lifetime.signal),
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    const sessionManager = createSessionManager(cwd, options.startup, log);

    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: getAgentDir(),
      sessionManager,
    });

    for (const diagnostic of runtime.diagnostics) {
      log(`[${diagnostic.type}] ${diagnostic.message}`);
    }
    if (runtime.modelFallbackMessage) {
      log(`[warning] ${runtime.modelFallbackMessage}`);
    }

    // 激活期的 dispatcher 是按引导期的设置快照建的；按权威 manager 重套一次，
    // 与 CLI 建完 runtime 后的做法一致。
    configureHttpDispatcher(runtime.services.settingsManager.getHttpIdleTimeoutMs());

    const wrapper: PiRuntime = new PiRuntime(
      runtime,
      subagents,
      terminals,
      lifetime,
      log,
      toolSetup,
      options.redirectClaimedSession,
    );
    // 所属 surface 得知非自己发起的替换的唯一入口：新会话已存在、扩展
    // `withSession` 回调之前运行，正是 re-attach 的位置。
    runtime.setRebindSession(async () => {
      if (wrapper.replacingSession) return;
      await wrapper.lifecycle?.reattach();
    });
    subagents.attachHost({
      getSession: () => wrapper.session,
      getCwd: () => wrapper.cwd,
      getConfig: () => readSubagentConfig(wrapper.cwd),
      // 与所有子会话共享：`createSubagentServices()` 原样传递这一实例。
      // 这里解析出的模型就是 lane 将运行的模型。
      getModelRuntime: () => wrapper.runtime.services.modelRuntime,
      createServices: async () => {
        const services = await createSubagentServices(wrapper.runtime.services);
        for (const diagnostic of services.diagnostics) {
          log(`[${diagnostic.type}] ${diagnostic.message}`);
        }
        return services;
      },
      bindExtensions: (session, abortHandler) => wrapper.bindSessionExtensions(session, abortHandler),
    });
    return wrapper;
  }

  get session() {
    return this.runtime.session;
  }

  get cwd(): string {
    return this.runtime.cwd;
  }

  /**
   * 本 runtime 所有权的取消令牌。SDK 的 auth 与模型调用都接受 `AbortSignal`；
   * 接通这一个，控制器 dispose 后就不会有 provider 探测在后台跑。
   */
  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  /** 把调用方的取消与本 runtime 的生命周期合并。 */
  withLifetime(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal;
  }

  /** 当前配有可用认证的模型。 */
  async getAvailableModels(signal?: AbortSignal) {
    return this.runtime.services.modelRuntime.getAvailable(undefined, { signal: this.withLifetime(signal) });
  }

  /** 供应商配置的认证是否基于付费订阅。 */
  isSubscriptionProvider(providerId: string): boolean {
    try {
      return this.runtime.services.modelRuntime.isUsingSubscription(providerId);
    } catch {
      return false;
    }
  }

  /** 直接访问 provider/auth 管理（登录、登出、状态）。 */
  get modelRuntime() {
    return this.runtime.services.modelRuntime;
  }

  /**
   * 从网络重新拉取各供应商的模型目录。
   *
   * 登录/登出已跑过同一个 `ModelRuntime.refresh()`，这里暴露给手动重试：目录
   * 拉取瞬时失败（代理、DNS、TLS）会沿用缓存列表，CLI 的选择器每次打开也做
   * 同样的调用。`force` 绕过目录新鲜度间隔，点击永远意味着「再问一次」。
   */
  async refreshModelCatalog(signal?: AbortSignal): Promise<ModelsRefreshResult> {
    return this.runtime.services.modelRuntime.refresh({ force: true, signal: this.withLifetime(signal) });
  }

  /**
   * 按当前可用性重新解析常用模型并应用到运行中的会话。
   *
   * `session.scopedModels` 在会话构建（及列表被编辑）时解析，auth 一变就过期：
   * 登出后常用菜单里还留着供应商的模型，登入或改 models.json 又不会补上新
   * 出现的。这里重读的正是唯一变化的输入——可用性。
   */
  async rescopeSessionModels(): Promise<void> {
    const scoped = await resolveScopedModels(this.runtime.services, this.log, this.lifetime.signal);
    this.runtime.session.setScopedModels([...scoped]);
  }

  /** 共享设置存储（`~/.pi/agent/settings.json`），CLI 同样读取。 */
  get settingsManager() {
    return this.runtime.services.settingsManager;
  }

  // 本会话的常用模型，由共享 `enabledModels` 设置解析；空表示不做限制、列出全部。
  get scopedModels(): ReadonlyArray<ScopedModel> {
    return this.runtime.session.scopedModels;
  }

  /**
   * 把常用模型列表持久化到 `~/.pi/agent/settings.json` 并重新限定运行中的
   * 会话，对齐 CLI 的 `/scoped-models`。`undefined`（或空列表）清除该设置，
   * 即重新提供全部模型。
   */
  async setEnabledModels(references: string[] | undefined): Promise<void> {
    const settings = this.runtime.services.settingsManager;
    settings.setEnabledModels(references?.length ? references : undefined);
    await settings.flush();
    const scoped = await resolveScopedModels(this.runtime.services, this.log, this.lifetime.signal);
    this.runtime.session.setScopedModels([...scoped]);
    this.log(`enabled models: ${references?.length ? references.join(", ") : "(all)"}`);
  }

  /**
   * 只切换当前会话的模型。
   *
   * SDK 0.84.3 起 `AgentSession.setModel()` 默认仅作用于会话，传
   * `options.persist` 才持久化——正是本宿主要的分离：只有选择器的 📌
   * （`setDefaultModel`）写启动默认值。0.84.2 会顺带改写
   * `defaultProvider`/`defaultModel`，旧版曾靠写回旧值对冲，该补丁已删。
   */
  async setModel(providerId: string, modelId: string): Promise<void> {
    const model = this.runtime.services.modelRuntime.getModel(providerId, modelId);
    if (!model) throw new Error(`Model not found: ${providerId}/${modelId}`);
    await this.runtime.session.setModel(model);
    this.log(`model switched to ${providerId}/${modelId}`);
  }

  /**
   * 持久化启动默认模型（CLI 选择器的 Ctrl+S）。
   *
   * 立即 flush：每次会话替换都会新建 services 重读 settings.json，不落盘的
   * 写入会被紧随其后的 `/new` 丢掉。
   */
  async setDefaultModel(providerId: string, modelId: string): Promise<void> {
    const settings = this.runtime.services.settingsManager;
    settings.setDefaultModelAndProvider(providerId, modelId);
    await settings.flush();
    this.log(`default model set to ${providerId}/${modelId}`);
  }

  /** 把 webview 支撑的扩展 UI 绑定到当前会话。 */
  async bindExtensions(): Promise<void> {
    await this.bindSessionExtensions(this.runtime.session, () => {
      void this.runtime.session.abort();
    }, { ownsSession: true });
  }

  /**
   * 把 `ctx.ui.notify` 路由进 transcript 而不是原生弹窗。
   *
   * 必须在首次 `bindExtensions()` 之前注入：sink 被那里创建的 UI 上下文捕获。
   */
  setExtensionNoticeSink(sink: (session: AgentSession, notice: ExtensionNotice) => void): void {
    this.extensionNotice = sink;
  }

  /**
   * 上报扩展 handler 失败，与 SDK 各 mode 的做法一致（三个 mode 都传
   * `onError`）。时序规则同 notice sink：首次 `bindExtensions()` 前注入。
   */
  setExtensionErrorSink(sink: (session: AgentSession, error: ExtensionError) => void): void {
    this.extensionError = sink;
  }

  /**
   * 把扩展状态行与 widget 路由到所属聊天 surface。
   *
   * 缺了这两个，SDK 侧仍能解析（UI 上下文兜底为 no-op），发布状态的扩展会在
   * CLI 正常、在这里无声消失。时序规则同上面的 sink。
   */
  setExtensionStatusSink(sink: (session: AgentSession, update: ExtensionStatusUpdate) => void): void {
    this.extensionStatus = sink;
  }

  setExtensionWidgetSink(sink: (session: AgentSession, update: ExtensionWidgetUpdate) => void): void {
    this.extensionWidget = sink;
  }

  /**
   * 由 `ChatBridge` 在首次 `bindExtensions()` 前注入，同其他 sink：它被那里
   * 创建的命令上下文捕获。
   */
  setSessionLifecycleSink(sink: SessionLifecycleSink): void {
    this.lifecycle = sink;
  }

  /**
   * 扩展*命令* handler 里 `ctx.*` 背后的动作。
   *
   * 会话替换是宿主的工作，SDK 不带默认实现：各 mode 自行提供（最接近的是
   * `modes/rpc/rpc-mode.ts`）。缺了它们，`ctx.newSession()` 等全是静默 no-op。
   * 只有本应用驱动的会话拿到它们——子代理绝不能把窗口的会话从父会话脚下
   * 换掉。
   */
  private commandContextActions(session: AgentSession): ExtensionCommandContextActions {
    return {
      waitForIdle: () => session.waitForIdle(),
      newSession: (options) => this.runtime.newSession(options),
      fork: async (entryId, options) => {
        const { cancelled } = await this.runtime.fork(entryId, options);
        return { cancelled };
      },
      navigateTree: async (targetId, options) => {
        const result = await session.navigateTree(targetId, options);
        // 树导航不换 session 对象、不触发 rebind 钩子，必须在这里重建 transcript。
        if (!result.cancelled) await this.lifecycle?.reattach();
        return { cancelled: result.cancelled };
      },
      switchSession: async (sessionPath, options) => {
        if (await this.redirectClaimedSession(sessionPath)) return { cancelled: true };
        return await this.runtime.switchSession(sessionPath, options);
      },
      reload: async () => {
        if (this.lifecycle) await this.lifecycle.reload();
        else await session.reload();
      },
    };
  }

  /**
   * 为本应用持有的 SDK 会话绑定扩展 UI 钩子。
   *
   * `ownsSession` 标记显示在顶层聊天 surface 上的会话；只有它拿到命令上下文。
   */
  async bindSessionExtensions(
    session: AgentSession,
    abortHandler: () => void,
    options?: { ownsSession?: boolean },
  ): Promise<void> {
    await session.bindExtensions({
      mode: "rpc",
      uiContext: createVsCodeExtensionUiContext({
        notice: this.extensionNotice ? (notice) => this.extensionNotice?.(session, notice) : undefined,
        status: this.extensionStatus ? (update) => this.extensionStatus?.(session, update) : undefined,
        widget: this.extensionWidget ? (update) => this.extensionWidget?.(session, update) : undefined,
      }),
      abortHandler,
      ...(options?.ownsSession ? { commandContextActions: this.commandContextActions(session) } : {}),
      ...(this.extensionError ? { onError: (error: ExtensionError) => this.extensionError?.(session, error) } : {}),
    });
  }

  /** 执行宿主发起的会话替换；调用方随后自行 re-attach。 */
  private async replacing<T>(action: () => Promise<T>): Promise<T> {
    this.replacingSession = true;
    try {
      return await action();
    } finally {
      this.replacingSession = false;
    }
  }

  async newSession(): Promise<void> {
    await this.replacing(() => this.runtime.newSession());
    this.log(`new session: ${this.runtime.session.sessionFile ?? "(in-memory)"}`);
  }

  private async redirectClaimedSession(sessionFile: string): Promise<boolean> {
    return Boolean(await this.openClaimRedirect?.(sessionFile));
  }

  /** 切到持久化会话；若已被其他顶层 runtime 持有则揭示那个 surface 并返回 false。 */
  async switchSession(sessionFile: string): Promise<boolean> {
    if (await this.redirectClaimedSession(sessionFile)) return false;
    const started = Date.now();
    await this.replacing(() => this.runtime.switchSession(sessionFile));
    this.log(`switched session: ${sessionFile} (load ${Date.now() - started}ms)`);
    return true;
  }

  /** 导入会话 JSONL 并设为当前会话。 */
  async importSession(path: string): Promise<void> {
    await this.replacing(() => this.runtime.importFromJsonl(path));
    this.log(`imported session: ${path}`);
  }

  /** 从某个 entry 分叉（`position: "at"` 时为复制）会话。 */
  async fork(entryId: string, options?: { position?: "before" | "at" }): Promise<{ cancelled: boolean; selectedText?: string }> {
    const result = await this.replacing(() => this.runtime.fork(entryId, options));
    if (!result.cancelled) this.log(`forked session: ${this.runtime.session.sessionFile ?? "(in-memory)"}`);
    return result;
  }

  /**
   * 重新发现 cwd 的扩展、技能、提示词与上下文文件。
   *
   * `AgentSession.reload()` 是 SDK 各 mode 跑 `/reload` 的同一条路；只调
   * `resourceLoader.reload()` 更糟——会话的 `ExtensionRunner` 用旧实例，重载
   * 结果无人使用。`reload()` 拆旧 runner、重载资源、重建 runner 与工具注册
   * 表（宿主 `customTools` 保留）并重发 `session_start`。`beforeSessionStart`
   * 在新 runner 已建、事件未发的空档运行，旧实例的宿主 UI 须在此清掉。
   */
  async reloadResources(options?: { beforeSessionStart?: () => void }): Promise<void> {
    await this.runtime.session.reload(options);
    this.log("reloaded extensions, skills, prompts and context files");
  }

  dispose(): void {
    this.lifetime.abort();
    // 终端本身有意保持打开：它们属于用户的窗口，可能正显示用户还在读的输出。
    this.terminals.dispose();
    void this.subagents.dispose().finally(() => this.runtime.dispose());
  }
}
