import type { WebviewMessage } from "../shared/protocol.js";

/** The single channel to the extension host. */

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  /** Persisted per-webview state; VS Code keeps it across webview reloads. */
  getState(): unknown;
  setState(state: unknown): void;
};

const vscodeApi = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
  vscodeApi.postMessage(message);
}

/** Read a value the webview persisted before a reload (`undefined` if absent). */
export function getPersisted<T>(key: string): T | undefined {
  const state = vscodeApi.getState();
  if (state === null || typeof state !== "object") return undefined;
  return (state as Record<string, unknown>)[key] as T | undefined;
}

/** Persist a value for the next incarnation of this webview. */
export function setPersisted(key: string, value: unknown): void {
  const state = vscodeApi.getState();
  const base = state !== null && typeof state === "object" ? (state as Record<string, unknown>) : {};
  base[key] = value;
  vscodeApi.setState(base);
}
