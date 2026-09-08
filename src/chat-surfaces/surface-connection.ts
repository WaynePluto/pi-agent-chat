import * as vscode from "vscode";
import type { HostMessage, WebviewMessage } from "../shared/protocol.js";
import type { ChatController } from "./controller.js";
import type { SurfaceKind } from "./types.js";

export class SurfaceConnection implements vscode.Disposable {
  controller?: ChatController;
  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;

  constructor(
    readonly kind: SurfaceKind,
    private readonly webview: vscode.Webview,
    readonly reveal: () => void,
    onMessage: (message: WebviewMessage) => void,
    private readonly onDispose: () => void,
    private readonly html: () => string,
  ) {
    this.subscriptions.push(this.webview.onDidReceiveMessage(onMessage));
  }

  bind(controller: ChatController): void {
    if (this.controller === controller) {
      this.render();
      return;
    }
    this.controller?.detach(this);
    this.controller = controller;
    controller.attach(this);
    this.render();
  }

  render(): void {
    if (!this.disposed) this.webview.html = this.html();
  }

  clearController(controller: ChatController): void {
    if (this.controller === controller) this.controller = undefined;
  }

  post(message: HostMessage): void {
    if (!this.disposed) void this.webview.postMessage(message);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const subscription of this.subscriptions) subscription.dispose();
    this.onDispose();
  }
}
