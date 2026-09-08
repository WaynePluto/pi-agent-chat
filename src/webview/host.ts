import type { WebviewMessage } from "../shared/protocol.js";

/** 通向扩展宿主的唯一通道。 */

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  /** 按 webview 持久化的状态；VS Code 在 webview 重载间保留它。 */
  getState(): unknown;
  setState(state: unknown): void;
};

const vscodeApi = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
  vscodeApi.postMessage(message);
}

/** 读取 webview 重载前持久化的值（不存在则 `undefined`）。 */
export function getPersisted<T>(key: string): T | undefined {
  const state = vscodeApi.getState();
  if (state === null || typeof state !== "object") return undefined;
  return (state as Record<string, unknown>)[key] as T | undefined;
}

/** 为本 webview 的下一世持久化一个值。 */
export function setPersisted(key: string, value: unknown): void {
  const state = vscodeApi.getState();
  const base = state !== null && typeof state === "object" ? (state as Record<string, unknown>) : {};
  base[key] = value;
  vscodeApi.setState(base);
}
