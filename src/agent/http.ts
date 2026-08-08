import { EventEmitter } from "node:events";
import * as vscode from "vscode";
import * as undici from "undici";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Proxy and HTTP dispatcher setup, kept behaviourally identical to the pi CLI.
 *
 * SDK-MIRROR: `core/http-dispatcher.ts` (`applyHttpProxySettings` +
 * `configureHttpDispatcher`) and their defaults. The CLI runs them from
 * `main.ts`; neither is part of the SDK's public export map, so the logic is
 * mirrored here rather than deep-imported from `dist/`. Re-check on SDK
 * upgrades.
 *
 * Proxy precedence, highest first:
 *   1. `http_proxy` / `HTTP_PROXY` (and the https/no_proxy variants) — the
 *      environment the extension host inherited from the OS or shell.
 *   2. `httpProxy` in `~/.pi/agent/settings.json` — pi's own setting, shared
 *      with the terminal CLI.
 *   3. VS Code's `http.proxy` — sidebar-only fallback, so the plugin can still
 *      reach the network in a VS Code that is configured but has no env vars.
 *
 * 1 and 2 are exactly the CLI's order (`applyHttpProxySettings` only fills env
 * vars that are unset). 3 is additive: it can only fill a gap where the CLI
 * would have gone direct, so the plugin never disagrees with the CLI.
 *
 * Note the env vars are read by undici lowercase-first
 * (`http_proxy ?? HTTP_PROXY`), while the fallbacks above are written to the
 * uppercase names — same as the CLI.
 */

/** SDK-MIRROR: `DEFAULT_HTTP_IDLE_TIMEOUT_MS` in `core/http-dispatcher.ts`. */
const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
/** Node's 250ms default can kill valid connection attempts on high-latency routes. */
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

/**
 * Resolve the proxy configuration and install the global dispatcher.
 *
 * Runs once at activation, before any SDK session exists.
 */
export function configureHttpProxy(cwd: string, log: (message: string) => void): void {
  const settings = readGlobalSettings(cwd, log);
  // Which proxy variables the OS/shell already provided, before any fallback
  // fills them in. Needed to attribute the effective value in the log below.
  const fromEnvironment = {
    http: Boolean(process.env.http_proxy?.trim() ?? process.env.HTTP_PROXY?.trim()),
    https: Boolean(process.env.https_proxy?.trim() ?? process.env.HTTPS_PROXY?.trim()),
  };

  // 2. pi's own setting (env vars set by the OS/shell already won).
  const piProxy = applyProxyEnv(settings?.httpProxy);

  // 3. VS Code, last.
  const httpConfig = vscode.workspace.getConfiguration("http");
  const vsCodeProxy = applyProxyEnv(httpConfig.get<string>("proxy"));
  if (httpConfig.get<boolean>("proxyStrictSSL") === false) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= "0";
  }

  configureHttpDispatcher(settings?.httpIdleTimeoutMs);

  const source = (fromEnv: boolean): string =>
    fromEnv ? "environment" : piProxy ? "pi settings.json" : vsCodeProxy ? "vscode http.proxy" : "none";
  const effective = effectiveProxies();
  if (effective.http === effective.https) {
    log(`http dispatcher installed (proxy: ${effective.http ?? "none"}, source: ${source(fromEnvironment.http)})`);
    return;
  }
  // undici resolves http and https independently, so a partially configured
  // environment can legitimately end up on two different proxies.
  log(
    `http dispatcher installed (http proxy: ${effective.http ?? "none"}, source: ${source(fromEnvironment.http)}; ` +
      `https proxy: ${effective.https ?? "none"}, source: ${source(fromEnvironment.https)})`,
  );
  log("[warning] http and https resolved to different proxies; set http(s)_proxy in pairs to avoid this");
}

/**
 * (Re)build the global undici dispatcher.
 *
 * Called again whenever the effective `httpIdleTimeoutMs` changes, mirroring
 * how the CLI reconfigures it from its settings selector.
 */
export function configureHttpDispatcher(timeoutMs: number | undefined = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
  const normalized = parseHttpIdleTimeoutMs(timeoutMs) ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  const dispatcher = withUndiciErrorListener(
    new undici.EnvHttpProxyAgent({
      allowH2: false,
      bodyTimeout: normalized,
      connect: { autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS },
      headersTimeout: normalized,
      clientFactory: createUndiciClient,
      factory: createUndiciOriginDispatcher,
    }),
  );
  undici.setGlobalDispatcher(dispatcher);
  // Keep fetch and the dispatcher on the same undici implementation: a mixed
  // pair can consume compressed responses without decompressing them. If
  // something replaced fetch after our last install, treat that as deliberate.
  const shouldInstallGlobals =
    installedGlobalFetch === undefined ? globalThis.fetch === originalGlobalFetch : globalThis.fetch === installedGlobalFetch;
  if (shouldInstallGlobals) {
    undici.install?.();
    installedGlobalFetch = globalThis.fetch;
  }
}

/** The proxies undici will actually use, in undici's own lookup order. */
function effectiveProxies(): { http?: string; https?: string } {
  const http = (process.env.http_proxy ?? process.env.HTTP_PROXY)?.trim() || undefined;
  const https = (process.env.https_proxy ?? process.env.HTTPS_PROXY)?.trim() || undefined;
  // undici falls back to the http agent when no https proxy is configured.
  return { http, https: https ?? http };
}

/**
 * Fill the proxy env vars, mirroring the CLI's `applyHttpProxySettings()`.
 * Returns the normalized value this source offered, or undefined.
 */
function applyProxyEnv(value: string | undefined): string | undefined {
  const proxy = value?.trim();
  if (!proxy) return undefined;
  process.env.HTTP_PROXY ??= proxy;
  process.env.HTTPS_PROXY ??= proxy;
  return proxy;
}

/**
 * Global-scope `~/.pi/agent/settings.json`, read the way the CLI bootstraps it.
 *
 * `projectTrusted: false` matches the CLI's bootstrap manager: project settings
 * must not influence networking before the trust prompt has been answered.
 * `httpProxy` is a global-only setting on both sides.
 */
function readGlobalSettings(cwd: string, log: (message: string) => void) {
  try {
    return SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false }).getGlobalSettings();
  } catch (error) {
    log(`could not read pi settings for proxy configuration: ${String(error)}`);
    return undefined;
  }
}

/** `"disabled"`/0 disables the timeout; invalid values fall back to the default. */
function parseHttpIdleTimeoutMs(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

const ignoreUndiciDispatcherError = (): void => {};

/**
 * undici can emit an internal Client "error" while tearing down a mid-stream
 * fetch body. The body stream still rejects through `reader.read()`; this
 * listener only stops EventEmitter's unhandled-"error" rule from crashing the
 * extension host.
 */
function withUndiciErrorListener<T>(dispatcher: T): T {
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
  }
  return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
  return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
  const poolOptions = options as undici.Pool.Options;
  if (poolOptions.connections === 1) return createUndiciClient(origin, options);
  return withUndiciErrorListener(new undici.Pool(origin, { ...poolOptions, factory: createUndiciClient }));
}
