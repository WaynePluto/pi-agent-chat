import * as vscode from "vscode";
// Bundled builds must register OAuth flows statically: the SDK hides them behind
// variable specifiers so bundlers cannot follow them (see esbuild.mjs).
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { ChatBridge } from "./agent/bridge.js";
import {
  formatDiagnostics,
  runHistoryReplayTest,
  runLiveToolCallTest,
  runProjectFilesTest,
  runSessionTreeTest,
  runSlashCommandTest,
  runSpikeDiagnostics,
  runSubagentToolTest,
} from "./agent/diagnostics.js";
import { OriginalContentProvider, ORIGINAL_SCHEME } from "./agent/diff-view.js";
import { describeWithStack } from "./agent/errors.js";
import { configureHttpProxy } from "./agent/http.js";
import { PiRuntime } from "./agent/runtime.js";
import type { HostMessage, WebviewMessage } from "./shared/protocol.js";

const VIEW_ID = "piAgentChat.view";

export function activate(context: vscode.ExtensionContext): void {
  registerBunOAuthFlows();
  const output = vscode.window.createOutputChannel("Pi Agent Chat");
  context.subscriptions.push(output);
  configureHttpProxy((message) => output.appendLine(message));

  const diffProvider = new OriginalContentProvider();
  const provider = new ChatViewProvider(context, output, diffProvider);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, diffProvider),
    diffProvider,
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("piAgentChat.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("piAgentChat.focus", () => vscode.commands.executeCommand(`${VIEW_ID}.focus`)),
    vscode.commands.registerCommand("piAgentChat.runSpikeDiagnostics", async () => {
      const results = [
        ...(await runSpikeDiagnostics()),
        ...(await runHistoryReplayTest(resolveWorkspaceCwd())),
        ...(await runSlashCommandTest(resolveWorkspaceCwd())),
        ...(await runSessionTreeTest(resolveWorkspaceCwd())),
        ...(await runSubagentToolTest(resolveWorkspaceCwd())),
        ...(await runProjectFilesTest(resolveWorkspaceCwd())),
      ];
      const report = formatDiagnostics(results);
      output.appendLine(report);
      output.show(true);
      const doc = await vscode.workspace.openTextDocument({ content: report, language: "markdown" });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand("piAgentChat.runSpikeLiveTest", async () => {
      const confirm = await vscode.window.showWarningMessage(
        "Run one real LLM prompt with a bash tool call? This consumes API tokens.",
        { modal: true },
        "Run",
      );
      if (confirm !== "Run") return;
      const cwd = resolveWorkspaceCwd();
      const results = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Pi Agent Chat: running live spike test" },
        () => runLiveToolCallTest(cwd, (message) => output.appendLine(message)),
      );
      const report = formatDiagnostics(results);
      output.appendLine(report);
      output.show(true);
    }),
    provider,
  );
}

export function deactivate(): void {}

/**
 * Re-exported for `scripts/smoke_load.mjs`, which runs the bundle in plain Node
 * with a stubbed `vscode` module. Not part of the extension's public surface.
 */
export const __spike = {
  runSpikeDiagnostics,
  runHistoryReplayTest,
  runSlashCommandTest,
  runSessionTreeTest,
  runSubagentToolTest,
  runProjectFilesTest,
  runLiveToolCallTest,
  formatDiagnostics,
  resolveWorkspaceCwd,
};

class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private runtime?: PiRuntime;
  private bridge?: ChatBridge;
  private starting?: Promise<void>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly diffProvider: OriginalContentProvider,
  ) {}

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    view.webview.html = this.renderHtml(view.webview);

    view.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      try {
        await this.ensureStarted();
        await this.bridge?.handleMessage(message);
      } catch (error) {
        this.reportError(error);
      }
    });

    void this.ensureStarted().catch((error) => this.reportError(error));
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private log(message: string): void {
    this.output.appendLine(message);
  }

  private async ensureStarted(): Promise<void> {
    if (this.bridge) return;
    this.starting ??= this.start();
    await this.starting;
  }

  private async start(): Promise<void> {
    const cwd = resolveWorkspaceCwd();
    this.log(`starting pi runtime in ${cwd}`);
    const runtime = await PiRuntime.create({ cwd, continueRecent: true, log: (message) => this.log(message) });
    const bridge = new ChatBridge(
      runtime,
      { post: (message) => this.post(message), log: (message) => this.log(message) },
      this.diffProvider,
    );
    await bridge.attach();
    this.runtime = runtime;
    this.bridge = bridge;
    this.log(`session ready: ${runtime.session.sessionFile ?? "(in-memory)"}`);
  }

  async newSession(): Promise<void> {
    try {
      await this.ensureStarted();
      await this.bridge?.handleMessage({ type: "newSession" });
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    const message = describeWithStack(error);
    this.log(`error: ${message}`);
    this.post({ type: "state", state: { ready: false, isStreaming: false, error: message.split("\n")[0] } });
    vscode.window.showErrorMessage(`Pi Agent Chat: ${message.split("\n")[0]}`);
  }

  private renderHtml(webview: vscode.Webview): string {
    const asset = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...parts));
    const scriptUri = asset("dist", "webview.js");
    const styleUri = asset("media", "main.css");
    const nonce = createNonce();
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>Pi Agent Chat</title>
  </head>
  <body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  dispose(): void {
    this.bridge?.dispose();
    this.runtime?.dispose();
  }
}

/** Multi-root workspaces fall back to the first folder (selector comes later). */
function resolveWorkspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath ?? process.cwd();
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i += 1) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
