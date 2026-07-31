import { EventEmitter } from "node:events";
import * as vscode from "vscode";
import * as undici from "undici";

/**
 * The CLI configures a proxy-aware global dispatcher during startup, but that
 * helper is not part of the SDK's public API. The extension therefore installs
 * its own dispatcher built from the bundled undici (aliased to >= 8.7.0, which
 * forwards plain HTTP through a proxy in absolute-form; see
 * `vscode-pi-design.md` 2.1).
 *
 * Proxy resolution order: VS Code `http.proxy` setting, then standard env vars.
 */
export function configureHttpProxy(log: (message: string) => void): void {
  const httpConfig = vscode.workspace.getConfiguration("http");
  const configuredProxy = httpConfig.get<string>("proxy")?.trim();
  if (configuredProxy) {
    process.env.HTTP_PROXY ??= configuredProxy;
    process.env.HTTPS_PROXY ??= configuredProxy;
  }
  if (httpConfig.get<boolean>("proxyStrictSSL") === false) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= "0";
  }

  const timeoutMs = 300_000;
  const dispatcher = new undici.EnvHttpProxyAgent({
    allowH2: false,
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
  });
  // undici can emit an internal client "error" while tearing down a mid-stream
  // fetch body; without a listener EventEmitter would turn it into a crash.
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", () => {});
  }
  undici.setGlobalDispatcher(dispatcher);
  // Keep global fetch on the same undici instance as the dispatcher.
  undici.install?.();

  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  log(`http dispatcher installed (proxy: ${proxy ?? "none"})`);
}
