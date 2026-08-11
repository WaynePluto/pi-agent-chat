import * as vscode from "vscode";
import {
  type AgentSessionServices,
  AgentSessionRuntime,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionUIContext,
  getAgentDir,
  resolveModelScopeWithDiagnostics,
  type ScopedModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { SubagentCoordinator } from "./subagent.js";
import { configureHttpDispatcher } from "./http.js";
import { t } from "./i18n.js";

export interface PiRuntimeOptions {
  cwd: string;
  /** Resume the most recent session for `cwd` instead of starting a new one. */
  continueRecent?: boolean;
  log: (message: string) => void;
}

/** A `ctx.ui.notify` call from a pi extension, routed to the transcript. */
export interface ExtensionNotice {
  level: "info" | "warning" | "error";
  text: string;
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
    /** Aborted on dispose; cancels every auth/model call this runtime started. */
    private readonly lifetime: AbortController,
    private readonly log: (message: string) => void,
  ) {}

  /** Injected by `ChatBridge`; routes extension notifications to a transcript. */
  private extensionNotice?: (session: AgentSession, notice: ExtensionNotice) => void;

  static async create(options: PiRuntimeOptions): Promise<PiRuntime> {
    const { cwd, log } = options;
    const subagents = new SubagentCoordinator(log);
    const lifetime = new AbortController();

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: effectiveCwd, sessionManager, sessionStartEvent }) => {
      // modelRuntimeSignal cancels the create-time credential restore and
      // availability probe when the view is closed mid-startup.
      const services = await createAgentSessionServices({ cwd: effectiveCwd, modelRuntimeSignal: lifetime.signal });
      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          // The only tool this extension adds to pi's own set. Everything else
          // the agent can call comes from pi or from a pi extension in
          // `~/.pi/agent/extensions/`, shared with the CLI.
          customTools: [subagents.tool],
          scopedModels: await resolveScopedModels(services, log, lifetime.signal),
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    const sessionManager = options.continueRecent ? SessionManager.continueRecent(cwd) : SessionManager.create(cwd);

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

    const wrapper = new PiRuntime(runtime, subagents, lifetime, log);
    subagents.attachHost({
      getSession: () => wrapper.session,
      getCwd: () => wrapper.cwd,
      getServices: () => wrapper.runtime.services,
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
   * closed sidebar does not leave provider probes running in the background.
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
    });
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

  /** Bind extension UI hooks for an SDK session owned by this application. */
  async bindSessionExtensions(session: AgentSession, abortHandler: () => void): Promise<void> {
    await session.bindExtensions({
      mode: "rpc",
      uiContext: createVsCodeExtensionUiContext(
        this.extensionNotice ? (notice) => this.extensionNotice?.(session, notice) : undefined,
      ),
      abortHandler,
    });
  }

  async newSession(): Promise<void> {
    await this.runtime.newSession();
    this.log(`new session: ${this.runtime.session.sessionFile ?? "(in-memory)"}`);
  }

  async switchSession(sessionFile: string): Promise<void> {
    const started = Date.now();
    await this.runtime.switchSession(sessionFile);
    this.log(`switched session: ${sessionFile} (load ${Date.now() - started}ms)`);
  }

  /** Import a session JSONL and make it the active session. */
  async importSession(path: string): Promise<void> {
    await this.runtime.importFromJsonl(path);
    this.log(`imported session: ${path}`);
  }

  /** Fork (or clone, with `position: "at"`) the session from an entry. */
  async fork(entryId: string, options?: { position?: "before" | "at" }): Promise<{ cancelled: boolean; selectedText?: string }> {
    const result = await this.runtime.fork(entryId, options);
    if (!result.cancelled) this.log(`forked session: ${this.runtime.session.sessionFile ?? "(in-memory)"}`);
    return result;
  }

  /** Re-discover extensions, skills, prompts and context files for the cwd. */
  async reloadResources(): Promise<void> {
    await this.runtime.services.resourceLoader.reload();
    await this.bindExtensions();
    this.log("reloaded extensions, skills, prompts and context files");
  }

  dispose(): void {
    this.lifetime.abort();
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
 * `ExtensionUIContext` also contains many TUI-only members (widgets, custom
 * components, themes). Those are served by a no-op Proxy fallback so an
 * extension written for the terminal cannot crash the extension host.
 *
 * `notify` goes to the transcript when a sink is wired (notifications are
 * often multi-line reports that a notification toast truncates); the native
 * popup stays as the fallback so nothing is silently dropped.
 */
function createVsCodeExtensionUiContext(notice?: (notice: ExtensionNotice) => void): ExtensionUIContext {
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
      if (notice) {
        notice({ level: type, text: message });
        return;
      }
      if (type === "error") vscode.window.showErrorMessage(message);
      else if (type === "warning") vscode.window.showWarningMessage(message);
      else vscode.window.showInformationMessage(message);
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
