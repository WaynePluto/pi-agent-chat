import type { WebviewMessage } from "../shared/protocol.js";

/** The single channel to the extension host. */

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscodeApi = acquireVsCodeApi();

export function post(message: WebviewMessage): void {
  vscodeApi.postMessage(message);
}
