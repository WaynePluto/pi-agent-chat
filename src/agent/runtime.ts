import * as vscode from "vscode";
import { existsSync } from "node:fs";
import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import {
  type AgentSessionServices,
  AgentSessionRuntime,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionError,
  type ExtensionCommandContextActions,
  type ExtensionUIContext,
  getAgentDir,
  resolveModelScopeWithDiagnostics,
  type ScopedModel,
  SessionManager,
  type WidgetPlacement,
} from "@earendil-works/pi-coding-agent";
import { SubagentCoordinator, SUBAGENT_TOOL } from "./subagent.js";
import { readSubagentConfig, readTerminalConfig, type SubagentConfig, type TerminalConfig } from "./config.js";
import { describe } from "./errors.js";
import { configureHttpDispatcher } from "./http.js";
import { t } from "./i18n.js";
import { VsCodeTerminalPool, VSCODE_TERMINAL_TOOL } from "./vscode-terminal.js";

/**
 * Which session a fresh runtime opens with.
 *
 * `file` is what a chat surface asks for on a normal start: it remembers the
 * session it was last showing, which is not the same as the most recent one on
 * disk (the user may have switched back to an older session, and the CLI may
 * have written a newer one in the same cwd since). `recent` is the fallback for
 * a window with nothing remembered, and matches `pi --continue`.
 */
export type StartupSession =
  | { mode: "new" }
  | { mode: "recent" }
  | { mode: "file"; path: string };

export interface PiRuntimeOptions {
  cwd: string;
  /** Defaults to a brand new session, as `pi` with no flags does. */
  startup?: StartupSession;
  log: (message: string) => void;
  /**
   * Services of another top-level runtime in this window.
   *
   * Only its model/auth and settings stores are shared. The new runtime still
   * receives a private ResourceLoader and extension runtime; sharing those
   * between two live sessions retargets every extension's `pi.*` actions and
   * makes disposal of either session poison the other one.
   */
  sharedServices?: AgentSessionServices;
  /**
   * Return true when another surface already owns `sessionFile` and handled
   * the request by revealing that surface. Checked for host- and
   * extension-initiated session switches before the SDK replaces anything.
   */
  redirectClaimedSession?: (sessionFile: string) => boolean | Promise<boolean>;
}

/**
 * Resolve `startup` against the session directory.
 *
 * A remembered file can be gone (deleted from the sessions page, or by another
 * host); that is expected rather than exceptional, so it degrades to the most
 * recent session instead of failing the whole start.
 */
function createSessionManager(
  cwd: string,
  startup: StartupSession | undefined,
  log: (message: string) => void,
): SessionManager {
  if (startup?.mode === "file") {
    try {
      // `SessionManager.open()` on a missing path would silently start an empty
      // session pinned to it, re-creating a file the user deleted, so the
      // existence check has to happen here.
      if (existsSync(startup.path)) return SessionManager.open(startup.path);
      log(`last session file is gone; continuing the most recent session instead: ${startup.path}`);
    } catch (error) {
      log(`cannot reopen ${startup.path} (${describe(error)}); continuing the most recent session instead`);
    }
    return SessionManager.continueRecent(cwd);
  }
  if (startup?.mode === "recent") return SessionManager.continueRecent(cwd);
  return SessionManager.create(cwd);
}

/**
 * How the current session's delegation tools were wired, written by the session
 * factory on every (re)build.
 *
 * Both values only feed the new-session notice: they describe how the session
 * on screen is set up, so they must come from the build that produced it rather
 * than from a setting that may have changed since.
 */
interface ToolSetupRef {
  /** Extension whose `subagent` tool was suppressed, if any. */
  shadowedSubagent?: string;
  /** Extension whose `vscode_terminal` tool was suppressed, if any. */
  shadowedTerminal?: string;
  /** The configuration this session's tool set was actually built from. */
  subagent: SubagentConfig;
  /** Likewise for the terminal tool. */
  terminal: TerminalConfig;
}

/**
 * Path of a loaded pi extension that registers a tool under `toolName`.
 *
 * Every name this plugin claims for a tool of its own is suppressed for
 * extensions, whether or not the plugin's tool is currently enabled: it cannot
 * know how an arbitrary extension implements a same-named tool (or which host
 * capabilities that implementation relies on), and one name must not mean two
 * things in one window. When the setting is on, the SDK's tool registry makes
 * the host tool win outright — a custom tool overrides an extension tool of
 * the same name (`core/agent-session.ts`, `_refreshToolRegistry()`) — and when
 * it is off the name is excluded. Either way the user is never offered an
 * extension tool whose arguments would not match the call shape their session
 * history records.
 *
 * Only the tool *name* is matched. No extension is identified by name, path
 * or capability, and nothing here inspects how an extension is implemented.
 *
 * Safe to call right after `createAgentSessionServices()`: it awaits
 * `resourceLoader.reload()` internally, so extension tool names are known
 * before the session (and its tool set) is built.
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
 * Build the services one subagent child session runs on.
 *
 * The child must not reuse the parent's services, and parallel children must
 * not reuse each other's. Extensions are loaded once
 * per `ResourceLoader`, and *every* session built from that loader shares the
 * resulting extension runtime: `core/agent-session.ts` builds its
 * `ExtensionRunner` from `resourceLoader.getExtensions()` (a cached result),
 * and `core/extensions/runner.ts` `bindCore()` copies the session's actions
 * into that shared runtime ("all extension APIs reference this"). So with a
 * shared loader a second live session silently retargets every extension's
 * `pi.*` at itself, and its `dispose()` marks the shared runtime stale —
 * after which every extension in the window throws "This extension ctx is
 * stale after session replacement or reload" on its next `pi.*` call, with no
 * way back short of rebuilding services. A private loader also *is* what an
 * isolated child session means: own extension instances, own event bus.
 *
 * `modelRuntime` and `settingsManager` are shared on purpose. Neither is
 * session-bound, and they carry the auth/model state and the project-trust
 * decision the parent already resolved. Extension factories do run again
 * against the shared `modelRuntime`; re-registering a provider is defined to
 * merge over the previous registration (`core/model-runtime.ts`).
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

/** Historical task-specific name; every live child still uses this path. */
export async function createSubagentServices(parent: AgentSessionServices): Promise<AgentSessionServices> {
  return await createIsolatedServices(parent);
}

/** A `ctx.ui.notify` call from a pi extension, routed to the transcript. */
export interface ExtensionNotice {
  level: "info" | "warning" | "error";
  text: string;
}

/**
 * A `ctx.ui.setStatus` / `ctx.ui.setWidget` call from a pi extension.
 *
 * Both are host-agnostic members of the SDK's `ExtensionUIContext` (the CLI
 * renders them in its footer and around its editor), so the sidebar owes them
 * a rendering the same way it owes one to `notify`. `text` / `lines` are
 * `undefined` when the extension clears its entry.
 */
export interface ExtensionStatusUpdate {
  key: string;
  text: string | undefined;
}

export interface ExtensionWidgetUpdate {
  key: string;
  lines: string[] | undefined;
  placement: WidgetPlacement;
}

/**
 * Host side of the extension command context (`ctx.*` in command handlers).
 *
 * `ctx.newSession()` / `ctx.fork()` / `ctx.switchSession()` /
 * `ctx.navigateTree()` / `ctx.reload()` all change what the owning surface must
 * display, and the SDK cannot do that half for us — the CLI wires the same
 * pair of concerns in `modes/rpc/rpc-mode.ts`.
 */
export interface SessionLifecycleSink {
  /** Rebuild the view: another session, or another branch of it, is current. */
  reattach(): Promise<void>;
  /** Reload resources, with the bookkeeping the sidebar does around it. */
  reload(): Promise<void>;
}

/**
 * Thin wrapper around the SDK's `AgentSessionRuntime`.
 *
 * Owns session replacement (new / resume) and re-binds extensions plus event
 * subscriptions whenever `runtime.session` is swapped, as required by the SDK.
 */
export class PiRuntime implements vscode.Disposable {
  private constructor(
    readonly runtime: AgentSessionRuntime,
    readonly subagents: SubagentCoordinator,
    readonly terminals: VsCodeTerminalPool,
    /** Aborted on dispose; cancels every auth/model call this runtime started. */
    private readonly lifetime: AbortController,
    private readonly log: (message: string) => void,
    /** Written by the session factory on every (re)build; see `shadowedSubagentExtension`. */
    private readonly toolSetupRef: ToolSetupRef,
    private readonly openClaimRedirect?: (sessionFile: string) => boolean | Promise<boolean>,
  ) {}

  /**
   * Path of a pi extension whose `subagent` tool is suppressed in this host.
   * Only drives the new-session notice — the tool set itself is decided in the
   * session factory.
   *
   * Re-evaluated whenever services are rebuilt (i.e. per effective cwd), so a
   * project-local extension is picked up too.
   */
  get shadowedSubagentExtension(): string | undefined {
    return this.toolSetupRef.shadowedSubagent;
  }

  /**
   * Whether this host's `subagent` tool is part of *this* session's tool set.
   *
   * Read from the session factory rather than from the setting: the tool set is
   * fixed when the session is built, so a setting flipped mid-conversation only
   * lands on the next session, and the notice must describe the session the
   * user is actually in.
   */
  get subagentEnabled(): boolean {
    return this.toolSetupRef.subagent.enabled;
  }

  /**
   * The subagent configuration this session's tool set was built from.
   *
   * The comparison target for a settings change: what matters is not what the
   * setting says now, but whether it still says what the session on screen was
   * assembled from.
   */
  get builtSubagentConfig(): SubagentConfig {
    return this.toolSetupRef.subagent;
  }

  /**
   * Path of a pi extension whose `vscode_terminal` tool is suppressed here.
   * Same rule and same mechanism as the subagent one above: the plugin owns
   * every name it gives a tool of its own.
   */
  get shadowedTerminalExtension(): string | undefined {
    return this.toolSetupRef.shadowedTerminal;
  }

  /** Whether this host's terminal tool is part of *this* session's tool set. */
  get terminalEnabled(): boolean {
    return this.toolSetupRef.terminal.enabled;
  }

  /** The terminal configuration this session's tool set was built from. */
  get builtTerminalConfig(): TerminalConfig {
    return this.toolSetupRef.terminal;
  }

  /** Injected by `ChatBridge`; routes extension notifications to a transcript. */
  private extensionNotice?: (session: AgentSession, notice: ExtensionNotice) => void;

  /** Injected by `ChatBridge`; routes extension runtime errors to a transcript. */
  private extensionError?: (session: AgentSession, error: ExtensionError) => void;

  /** Injected by `ChatBridge`; routes `ctx.ui.setStatus` to the status line. */
  private extensionStatus?: (session: AgentSession, update: ExtensionStatusUpdate) => void;

  /** Injected by `ChatBridge`; routes `ctx.ui.setWidget` to the composer edges. */
  private extensionWidget?: (session: AgentSession, update: ExtensionWidgetUpdate) => void;

  /** Injected by `ChatBridge`; see `SessionLifecycleSink`. */
  private lifecycle?: SessionLifecycleSink;

  /**
   * True while this wrapper is driving a session replacement itself.
   *
   * Host-driven replacements re-attach the view on their own, so the rebind
   * hook must stay out of the way; extension-driven ones (`ctx.newSession()`
   * and friends) resolve entirely inside the SDK and have no other way in.
   */
  private replacingSession = false;

  static async create(options: PiRuntimeOptions): Promise<PiRuntime> {
    const { cwd, log } = options;
    const subagents = new SubagentCoordinator(log);
    const lifetime = new AbortController();
    const toolSetup: ToolSetupRef = { subagent: readSubagentConfig(cwd), terminal: readTerminalConfig(cwd) };
    // Annotated because the pool asks the wrapper for the current cwd while the
    // wrapper owns the pool: without the annotations the two infer through each
    // other and land on `any`.
    const terminals: VsCodeTerminalPool = new VsCodeTerminalPool(() => wrapper.cwd, log);

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: effectiveCwd, sessionManager, sessionStartEvent }) => {
      // modelRuntimeSignal cancels the create-time credential restore and
      // availability probe when the view is closed mid-startup.
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
      // Read per session, not once at startup: the tool set is fixed when the
      // session is built, so this is the point where a changed setting lands.
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
          // The only tools this extension adds to pi's own set, and only when
          // the user asked for them. Everything else the agent can call comes
          // from pi or from a pi extension in `~/.pi/agent/extensions/`, shared
          // with the CLI.
          customTools: [
            ...(subagentConfig.enabled ? [subagents.createTool(subagentConfig)] : []),
            ...(terminalConfig.enabled ? [terminals.createTool(terminalConfig)] : []),
          ],
          // Both names belong to this window, in either switch state: enabled,
          // no exclusion is needed — the SDK's tool registry lets a custom tool
          // override an extension tool of the same name
          // (`core/agent-session.ts`, `_refreshToolRegistry()`), so the model
          // always resolves the name to this host's tool; disabled, the name is
          // excluded so the extension's tool is not offered either. The
          // exclusion set (and the custom tools) persist on the session, so
          // `/reload` keeps whichever arrangement the session was built with.
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

    // The activation-time dispatcher was built from the bootstrap settings
    // read; re-apply from the authoritative manager, as the CLI does after it
    // creates its runtime.
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
    // The only place the owning surface hears about a replacement it did not start.
    // Runs once the new session exists and before the extension's `withSession`
    // callback, which is exactly where re-attaching belongs.
    runtime.setRebindSession(async () => {
      if (wrapper.replacingSession) return;
      await wrapper.lifecycle?.reattach();
    });
    subagents.attachHost({
      getSession: () => wrapper.session,
      getCwd: () => wrapper.cwd,
      getConfig: () => readSubagentConfig(wrapper.cwd),
      // Shared with every child: `createSubagentServices()` passes this exact
      // instance on, so a model resolved here is the one a lane will run.
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
   * Cancellation token for everything this runtime owns. The SDK's auth and
   * model calls all take an `AbortSignal`; wiring this one through means a
   * disposed controller does not leave provider probes running in the background.
   */
  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  /** Combine a caller's cancellation with this runtime's lifetime. */
  withLifetime(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal;
  }

  /** Models that currently have working authentication configured. */
  async getAvailableModels(signal?: AbortSignal) {
    return this.runtime.services.modelRuntime.getAvailable(undefined, { signal: this.withLifetime(signal) });
  }

  /** Whether the provider's configured auth is backed by a paid subscription. */
  isSubscriptionProvider(providerId: string): boolean {
    try {
      return this.runtime.services.modelRuntime.isUsingSubscription(providerId);
    } catch {
      return false;
    }
  }

  /** Direct access to provider/auth management (login, logout, status). */
  get modelRuntime() {
    return this.runtime.services.modelRuntime;
  }

  /**
   * Re-fetch every provider's model catalogue from the network.
   *
   * The same `ModelRuntime.refresh()` login/logout already run, exposed for a
   * manual retry: a catalogue fetch that failed transiently (proxy, DNS, TLS)
   * leaves the provider on its cached list, and the CLI offers the same call
   * every time its model selector opens (`refreshModels()`, 15s timeout).
   * `force` bypasses the catalogue freshness interval so the click always
   * means "go ask again".
   */
  async refreshModelCatalog(signal?: AbortSignal): Promise<ModelsRefreshResult> {
    return this.runtime.services.modelRuntime.refresh({ force: true, signal: this.withLifetime(signal) });
  }

  /**
   * Re-resolve the frequently used models against current availability and
   * apply them to the running session.
   *
   * `session.scopedModels` is resolved when the session is built (and when the
   * list itself is edited), so it goes stale whenever auth changes: logging out
   * leaves the provider's models in the composer's quick menu, logging in or
   * editing models.json does not add newly available ones. Availability is the
   * only input that changed, which is exactly what this re-reads.
   */
  async rescopeSessionModels(): Promise<void> {
    const scoped = await resolveScopedModels(this.runtime.services, this.log, this.lifetime.signal);
    this.runtime.session.setScopedModels([...scoped]);
  }

  /** Shared settings store (`~/.pi/agent/settings.json`), also read by the CLI. */
  get settingsManager() {
    return this.runtime.services.settingsManager;
  }

  /**
   * Frequently used ("scoped") models for this session, resolved from the
   * shared `enabledModels` setting. Empty means "no scoping, all models".
   */
  get scopedModels(): ReadonlyArray<ScopedModel> {
    return this.runtime.session.scopedModels;
  }

  /**
   * Persist the frequently used model list into `~/.pi/agent/settings.json`
   * and re-scope the running session, mirroring the CLI's `/scoped-models`.
   *
   * `undefined` (or an empty list) clears the setting, meaning every model is
   * offered again.
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
   * Switch the model for the current session only.
   *
   * `AgentSession.setModel()` also rewrites `defaultProvider`/`defaultModel`
   * (CLI semantics: picking a model there means "make it the default"). The
   * sidebar keeps the two apart — only the picker's pin button changes the
   * startup default — so the previous default is written back here.
   */
  async setModel(providerId: string, modelId: string): Promise<void> {
    const model = this.runtime.services.modelRuntime.getModel(providerId, modelId);
    if (!model) throw new Error(`Model not found: ${providerId}/${modelId}`);
    const settings = this.runtime.services.settingsManager;
    const previousProvider = settings.getDefaultProvider();
    const previousModel = settings.getDefaultModel();
    await this.runtime.session.setModel(model);
    if (previousProvider && previousModel && (previousProvider !== providerId || previousModel !== modelId)) {
      settings.setDefaultModelAndProvider(previousProvider, previousModel);
      await settings.flush();
    }
    this.log(`model switched to ${providerId}/${modelId}`);
  }

  /**
   * Persist the startup default model (CLI selector's Ctrl+S).
   *
   * Flushed eagerly: every session replacement builds fresh services that
   * re-read settings.json, so an unflushed write would be lost to a `/new`
   * issued right after.
   */
  async setDefaultModel(providerId: string, modelId: string): Promise<void> {
    const settings = this.runtime.services.settingsManager;
    settings.setDefaultModelAndProvider(providerId, modelId);
    await settings.flush();
    this.log(`default model set to ${providerId}/${modelId}`);
  }

  /** Bind the webview-backed extension UI to the current session. */
  async bindExtensions(): Promise<void> {
    await this.bindSessionExtensions(this.runtime.session, () => {
      void this.runtime.session.abort();
    }, { ownsSession: true });
  }

  /**
   * Route `ctx.ui.notify` into the transcript instead of native popups.
   *
   * Must be set before the first `bindExtensions()` call, since the sink is
   * captured by the UI context created there.
   */
  setExtensionNoticeSink(sink: (session: AgentSession, notice: ExtensionNotice) => void): void {
    this.extensionNotice = sink;
  }

  /**
   * Report extension handler failures, the way every SDK mode does
   * (`interactive-mode.ts`, `rpc-mode.ts`, `print-mode.ts` all pass `onError`).
   * Same timing rule as the notice sink: set before the first
   * `bindExtensions()`.
   */
  setExtensionErrorSink(sink: (session: AgentSession, error: ExtensionError) => void): void {
    this.extensionError = sink;
  }

  /**
   * Route the extension status line and widgets to the owning chat surface.
   *
   * Without these two the SDK surface still resolves (the UI context falls back
   * to a no-op), so an extension that publishes a status would simply vanish in
   * the sidebar while working in the CLI. Same timing rule as the sinks above.
   */
  setExtensionStatusSink(sink: (session: AgentSession, update: ExtensionStatusUpdate) => void): void {
    this.extensionStatus = sink;
  }

  setExtensionWidgetSink(sink: (session: AgentSession, update: ExtensionWidgetUpdate) => void): void {
    this.extensionWidget = sink;
  }

  /**
   * Injected by `ChatBridge` before the first `bindExtensions()`, like the
   * other sinks: it is captured by the command context created there.
   */
  setSessionLifecycleSink(sink: SessionLifecycleSink): void {
    this.lifecycle = sink;
  }

  /**
   * Actions behind `ctx.*` in extension *command* handlers.
   *
   * Session replacement is host work, so the SDK ships no default: every mode
   * supplies its own (`modes/rpc/rpc-mode.ts` is the closest to this one).
   * Without them `ctx.newSession()` and friends are silent no-ops.
   *
   * Only the session this application drives gets them — a subagent child must
   * not be able to replace the window's session out from under its parent.
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
        // Tree navigation keeps the session object but changes the branch, so
        // no rebind hook fires: the transcript has to be rebuilt here.
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
   * Bind extension UI hooks for an SDK session owned by this application.
   *
   * `ownsSession` marks the session shown on a top-level chat surface; only it gets the
   * command context actions.
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

  /** Run a host-initiated session replacement; the caller re-attaches after. */
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

  /**
   * Switch to a persisted session unless another top-level runtime owns it.
   * Returns false when the owning surface was revealed instead.
   */
  async switchSession(sessionFile: string): Promise<boolean> {
    if (await this.redirectClaimedSession(sessionFile)) return false;
    const started = Date.now();
    await this.replacing(() => this.runtime.switchSession(sessionFile));
    this.log(`switched session: ${sessionFile} (load ${Date.now() - started}ms)`);
    return true;
  }

  /** Import a session JSONL and make it the active session. */
  async importSession(path: string): Promise<void> {
    await this.replacing(() => this.runtime.importFromJsonl(path));
    this.log(`imported session: ${path}`);
  }

  /** Fork (or clone, with `position: "at"`) the session from an entry. */
  async fork(entryId: string, options?: { position?: "before" | "at" }): Promise<{ cancelled: boolean; selectedText?: string }> {
    const result = await this.replacing(() => this.runtime.fork(entryId, options));
    if (!result.cancelled) this.log(`forked session: ${this.runtime.session.sessionFile ?? "(in-memory)"}`);
    return result;
  }

  /**
   * Re-discover extensions, skills, prompts and context files for the cwd.
   *
   * `AgentSession.reload()` is what every SDK mode runs for `/reload`
   * (`modes/rpc/rpc-mode.ts`, `modes/print-mode.ts`,
   * `modes/interactive/interactive-mode.ts`). Reloading the resource loader on
   * its own is not enough, and is in fact worse than doing nothing: the session
   * builds its `ExtensionRunner` once from `resourceLoader.getExtensions()`, so
   * it keeps the *old* extension instances while the reloaded set sits unused
   * in the loader, and a `bindExtensions()` after it would re-fire
   * `session_start` into those old instances. `reload()` shuts the old runner
   * down, reloads settings and resources, rebuilds the runner and the tool
   * registry (host `customTools` and the active tool set are preserved) and
   * re-emits `session_start` with reason "reload" through the UI bindings
   * already attached — so no `bindExtensions()` call belongs after it.
   *
   * `beforeSessionStart` runs once the new runner exists but before it sees
   * `session_start`: the point where host UI owned by the old instances has to
   * be dropped, so the new ones can republish it (the CLI restores its chat
   * there).
   */
  async reloadResources(options?: { beforeSessionStart?: () => void }): Promise<void> {
    await this.runtime.session.reload(options);
    this.log("reloaded extensions, skills, prompts and context files");
  }

  dispose(): void {
    this.lifetime.abort();
    // Terminals themselves are deliberately left open: they belong to the
    // user's window, and one may be showing output they are still reading.
    this.terminals.dispose();
    void this.subagents.dispose().finally(() => this.runtime.dispose());
  }
}

/**
 * Resolve the shared `enabledModels` patterns against the authenticated model
 * catalogue, using the same matching rules as the CLI's `--models` flag.
 */
async function resolveScopedModels(
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

/**
 * Maps the SDK's extension UI hooks onto native VS Code dialogs.
 *
 * `ExtensionUIContext` also contains many TUI-only members (custom components,
 * themes, raw terminal input). Those are served by a no-op Proxy fallback so an
 * extension written for the terminal cannot crash the extension host.
 *
 * `notify` goes to the transcript when a sink is wired (notifications are
 * often multi-line reports that a notification toast truncates); the native
 * popup stays as the fallback so nothing is silently dropped.
 *
 * `setStatus` and `setWidget` are *not* TUI-only despite living next to the
 * component-based members: their string forms describe content, not layout, so
 * every host owes them a rendering. They used to fall through to the Proxy,
 * which made extensions that publish a status silently do nothing here while
 * working in the CLI.
 */
function createVsCodeExtensionUiContext(sinks: {
  notice?: (notice: ExtensionNotice) => void;
  status?: (update: ExtensionStatusUpdate) => void;
  widget?: (update: ExtensionWidgetUpdate) => void;
}): ExtensionUIContext {
  const implemented: Record<string, unknown> = {
    async select(title: string, options: string[]): Promise<string | undefined> {
      return vscode.window.showQuickPick(options, { title, ignoreFocusOut: true });
    },
    async confirm(title: string, message: string): Promise<boolean> {
      const yes = t("confirmYes");
      const answer = await vscode.window.showInformationMessage(title, { modal: true, detail: message }, yes);
      return answer === yes;
    },
    async input(title: string, placeholder?: string): Promise<string | undefined> {
      return vscode.window.showInputBox({ title, placeHolder: placeholder, ignoreFocusOut: true });
    },
    async editor(title: string, prefill?: string): Promise<string | undefined> {
      return vscode.window.showInputBox({ title, value: prefill, ignoreFocusOut: true });
    },
    notify(message: string, type: "info" | "warning" | "error" = "info"): void {
      if (sinks.notice) {
        sinks.notice({ level: type, text: message });
        return;
      }
      if (type === "error") vscode.window.showErrorMessage(message);
      else if (type === "warning") vscode.window.showWarningMessage(message);
      else vscode.window.showInformationMessage(message);
    },
    setStatus(key: string, text: string | undefined): void {
      sinks.status?.({ key, text: text === undefined ? undefined : String(text) });
    },
    /**
     * Only the `string[]` overload is forwarded. The other one takes a
     * `(tui, theme) => Component` factory built on pi-tui, which the webview
     * cannot render; dropping it keeps the extension running with its widget
     * missing instead of failing the call.
     */
    setWidget(key: string, content: unknown, options?: { placement?: WidgetPlacement }): void {
      if (typeof content === "function") return;
      const lines = content === undefined ? undefined : Array.isArray(content) ? content.map(String) : [String(content)];
      sinks.widget?.({ key, lines, placement: options?.placement ?? "aboveEditor" });
    },
    onTerminalInput: () => () => {},
    getEditorText: () => "",
    getEditorComponent: () => undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching is not supported in the VS Code webview" }),
    getToolsExpanded: () => false,
    async custom() {
      return undefined;
    },
  };

  return new Proxy(implemented, {
    get(target, property) {
      if (property in target) return target[property as string];
      // Unsupported TUI-only surface: swallow the call instead of throwing.
      return () => undefined;
    },
    has: () => true,
  }) as unknown as ExtensionUIContext;
}
