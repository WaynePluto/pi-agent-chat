import { EventEmitter } from "node:events";
import * as vscode from "vscode";
import * as undici from "undici";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * 代理与 HTTP dispatcher 配置，行为与 pi CLI 保持一致。
 * SDK-MIRROR: `core/http-dispatcher.ts`（`applyHttpProxySettings` +
 * `configureHttpDispatcher` 及默认值）——不在 SDK 公开导出面上，在此
 * 镜像而非 deep import `dist/`；SDK 升级时需复查。
 *
 * 代理优先级：环境变量（`http_proxy` 等）> pi 设置 `httpProxy` >
 * VS Code `http.proxy`。前两级即 CLI 顺序，第三级只填 CLI 本会直连的
 * 空位；undici 先读小写变量、兜底写大写名。
 */

/** SDK-MIRROR: `core/http-dispatcher.ts` 的 `DEFAULT_HTTP_IDLE_TIMEOUT_MS`。 */
const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
/** Node 默认的 250ms 会掐死高延迟链路上合法的连接尝试。 */
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

/**
 * 解析代理配置并安装全局 dispatcher。
 *
 * 激活时运行一次，先于任何 SDK 会话存在。
 */
export function configureHttpProxy(cwd: string, log: (message: string) => void): void {
  const settings = readGlobalSettings(cwd, log);
  // OS/shell 已提供的代理变量（在任何兜底填充之前），
  // 供下面日志正确归属生效值的来源。
  const fromEnvironment = {
    http: Boolean(process.env.http_proxy?.trim() ?? process.env.HTTP_PROXY?.trim()),
    https: Boolean(process.env.https_proxy?.trim() ?? process.env.HTTPS_PROXY?.trim()),
  };

  // 2. pi 自己的设置（OS/shell 设的环境变量已胜出）。
  const piProxy = applyProxyEnv(settings?.httpProxy);

  // 3. VS Code，最后。
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
  // undici 对 http 与 https 各自独立解析，只配了一半的环境合法地
  // 落到两个不同代理上。
  log(
    `http dispatcher installed (http proxy: ${effective.http ?? "none"}, source: ${source(fromEnvironment.http)}; ` +
      `https proxy: ${effective.https ?? "none"}, source: ${source(fromEnvironment.https)})`,
  );
  log("[warning] http and https resolved to different proxies; set http(s)_proxy in pairs to avoid this");
}

/**
 * （重新）构建全局 undici dispatcher。
 *
 * 生效的 `httpIdleTimeoutMs` 变化时再次调用，对齐 CLI 在其设置选择器里
 * 的重配方式。
 */
export function configureHttpDispatcher(timeoutMs: number | undefined = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
  const normalized = parseHttpIdleTimeoutMs(timeoutMs) ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
  const dispatcher = withUndiciErrorListener(
    new undici.EnvHttpProxyAgent({
      allowH2: false,
      // 保持 HTTP origin 在 CONNECT 隧道上的行为与 Undici 8.7 之前一致
      // （SDK 修复：走代理的明文 HTTP 请求在一次工具调用后挂起）。
      proxyTunnel: true,
      bodyTimeout: normalized,
      connect: { autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS },
      headersTimeout: normalized,
      clientFactory: createUndiciClient,
      factory: createUndiciOriginDispatcher,
    }),
  );
  undici.setGlobalDispatcher(dispatcher);
  // 让 fetch 与 dispatcher 用同一份 undici 实现：混搭的一对会消费压缩
  // 响应却不解压。上次安装后若有别的代码换过 fetch，视为有意为之。
  const shouldInstallGlobals =
    installedGlobalFetch === undefined ? globalThis.fetch === originalGlobalFetch : globalThis.fetch === installedGlobalFetch;
  if (shouldInstallGlobals) {
    undici.install?.();
    installedGlobalFetch = globalThis.fetch;
  }
}

/** undici 实际会用的代理，按 undici 自己的查找顺序。 */
function effectiveProxies(): { http?: string; https?: string } {
  const http = (process.env.http_proxy ?? process.env.HTTP_PROXY)?.trim() || undefined;
  const https = (process.env.https_proxy ?? process.env.HTTPS_PROXY)?.trim() || undefined;
  // 未配 https 代理时 undici 回落到 http agent。
  return { http, https: https ?? http };
}

/**
 * 填充代理环境变量，镜像 CLI 的 `applyHttpProxySettings()`。
 * 返回该来源提供的规范化值，没有则 undefined。
 */
function applyProxyEnv(value: string | undefined): string | undefined {
  const proxy = value?.trim();
  if (!proxy) return undefined;
  process.env.HTTP_PROXY ??= proxy;
  process.env.HTTPS_PROXY ??= proxy;
  return proxy;
}

/**
 * 全局作用域的 `~/.pi/agent/settings.json`，按 CLI 引导时的读法。
 *
 * `projectTrusted: false` 对齐 CLI 的引导 manager：信任提示未回答前，
 * 项目设置不得影响网络。`httpProxy` 两边都是仅全局生效的设置。
 */
function readGlobalSettings(cwd: string, log: (message: string) => void) {
  try {
    return SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false }).getGlobalSettings();
  } catch (error) {
    log(`could not read pi settings for proxy configuration: ${String(error)}`);
    return undefined;
  }
}

/** `"disabled"`/0 表示禁用超时；非法值回落到默认。 */
function parseHttpIdleTimeoutMs(value: number | string | undefined): number | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.toLowerCase() === "disabled") return 0;
    if (trimmed.length === 0) return undefined;
    return parseHttpIdleTimeoutMs(Number(trimmed));
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

const ignoreUndiciDispatcherError = (): void => {};

/**
 * undici 在拆一个中途的 fetch body 时可能发出内部 Client "error"。
 * body 流仍会经 `reader.read()` 拒绝；此监听只是阻止 EventEmitter 的
 * 未处理 "error" 规则把扩展宿主打崩。
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
