import * as vscode from "vscode";
// Bundled builds must register OAuth flows statically: the SDK hides them behind
// variable specifiers so bundlers cannot follow them (see esbuild.mjs).
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import {
  formatDiagnostics,
  runHistoryReplayTest,
  runLiveToolCallTest,
  runManualRetryTest,
  runReplayedRetryOfferTest,
  runRetryOfferLifecycleTest,
  runProjectFilesTest,
  runResourceListingTest,
  runViewStateTest,
  runStartupSessionTest,
  runExtensionReloadTest,
  runExtensionCommandContextTest,
  runSessionTreeTest,
  runSlashCommandTest,
  runSpikeDiagnostics,
  runSurfaceCoordinationTest,
  runSubagentToolTest,
  runTerminalToolTest,
  runExtensionSdkImportTest,
} from "./agent/diagnostics.js";
import { OriginalContentProvider, ORIGINAL_SCHEME } from "./agent/diff-view.js";
import { configureHttpProxy } from "./agent/http.js";
import { runTerminalIntegrationSpike } from "./agent/terminal-spike.js";
import { CHAT_PANEL_TYPE, CHAT_VIEW_ID, ChatSurfaceManager } from "./chat-surfaces.js";

export function activate(context: vscode.ExtensionContext): void {
  // SDK-MIRROR: dist/cli.js sets these on the way in, and rpc-entry.js repeats
  // PI_CODING_AGENT — they are application-entry duties, not CLI decoration.
  // Extensions and anything the `bash` tool runs read them to tell they are
  // inside an agent (pagers, colour, prompts). The rest of cli.js is
  // deliberately not mirrored: process.title and emitWarning belong to VS Code
  // here, and the HTTP dispatcher is configured by agent/http.ts below.
  process.env.PI_CODING_AGENT = "true";
  process.env.AI_AGENT = "pi";
  registerBunOAuthFlows();
  const output = vscode.window.createOutputChannel("Pi Agent Chat");
  context.subscriptions.push(output);
  const cwd = resolveWorkspaceCwd();
  configureHttpProxy(cwd, (message) => output.appendLine(message));

  const diffProvider = new OriginalContentProvider();
  const surfaces = new ChatSurfaceManager(context, output, diffProvider, cwd);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, diffProvider),
    diffProvider,
    vscode.window.registerWebviewViewProvider(
      CHAT_VIEW_ID,
      { resolveWebviewView: (view) => surfaces.resolveSidebar(view) },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.window.registerWebviewPanelSerializer(CHAT_PANEL_TYPE, {
      deserializeWebviewPanel: (panel, state) => surfaces.restoreEditorPanel(panel, state),
    }),
    vscode.commands.registerCommand("piAgentChat.newSession", () => surfaces.newSidebarSession()),
    vscode.commands.registerCommand("piAgentChat.newEditorSession", () => surfaces.newEditorSession()),
    vscode.commands.registerCommand("piAgentChat.newWindowSession", () => surfaces.newWindowSession()),
    vscode.commands.registerCommand("piAgentChat.moveSessionToEditor", () => surfaces.openEditor()),
    vscode.commands.registerCommand("piAgentChat.moveSessionToEditorArea", () => surfaces.moveToEditorArea()),
    vscode.commands.registerCommand("piAgentChat.moveSessionToSidebar", () => surfaces.openInSidebar()),
    vscode.commands.registerCommand("piAgentChat.moveSessionFromSidebarToWindow", () => surfaces.moveToNewWindow("sidebar")),
    vscode.commands.registerCommand("piAgentChat.moveSessionFromEditorToWindow", () => surfaces.moveToNewWindow("editor")),
    vscode.commands.registerCommand("piAgentChat.focus", () => vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`)),
    vscode.commands.registerCommand("piAgentChat.runSpikeDiagnostics", async () => {
      const results = [
        ...(await runSpikeDiagnostics()),
        ...runSurfaceCoordinationTest(),
        ...(await runHistoryReplayTest(resolveWorkspaceCwd())),
        ...(await runSlashCommandTest(resolveWorkspaceCwd())),
        ...(await runManualRetryTest(resolveWorkspaceCwd())),
        ...(await runReplayedRetryOfferTest(resolveWorkspaceCwd())),
        ...(await runRetryOfferLifecycleTest(resolveWorkspaceCwd())),
        ...(await runSessionTreeTest(resolveWorkspaceCwd())),
        ...(await runSubagentToolTest(resolveWorkspaceCwd())),
        ...(await runTerminalToolTest(resolveWorkspaceCwd())),
        ...(await runProjectFilesTest(resolveWorkspaceCwd())),
        ...(await runExtensionSdkImportTest(resolveWorkspaceCwd())),
        ...(await runExtensionReloadTest(resolveWorkspaceCwd())),
        ...(await runExtensionCommandContextTest(resolveWorkspaceCwd())),
        ...(await runResourceListingTest(resolveWorkspaceCwd())),
        ...(await runViewStateTest(resolveWorkspaceCwd())),
        ...(await runStartupSessionTest(resolveWorkspaceCwd())),
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
      const liveCwd = resolveWorkspaceCwd();
      const results = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Pi Agent Chat: running live spike test" },
        () => runLiveToolCallTest(liveCwd, (message) => output.appendLine(message)),
      );
      const report = formatDiagnostics(results);
      output.appendLine(report);
      output.show(true);
    }),
    vscode.commands.registerCommand("piAgentChat.runTerminalSpike", async () => {
      const confirm = await vscode.window.showWarningMessage(
        "Probe VS Code shell integration for the proposed `terminal` tool? A terminal opens and one probe asks you to type a token into it.",
        { modal: true },
        "Run",
      );
      if (confirm !== "Run") return;
      output.show(true);
      const results = await runTerminalIntegrationSpike(resolveWorkspaceCwd(), (message) =>
        output.appendLine(message),
      );
      const report = formatDiagnostics(results);
      output.appendLine(report);
      const doc = await vscode.workspace.openTextDocument({ content: report, language: "markdown" });
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    surfaces,
  );
}

export function deactivate(): void {}

/**
 * Re-exported for `scripts/smoke_load.mjs`, which runs the bundle in plain Node
 * with a stubbed `vscode` module. Not part of the extension's public surface.
 */
export const __spike = {
  runSpikeDiagnostics,
  runSurfaceCoordinationTest,
  runHistoryReplayTest,
  runSlashCommandTest,
  runManualRetryTest,
  runReplayedRetryOfferTest,
  runRetryOfferLifecycleTest,
  runSessionTreeTest,
  runSubagentToolTest,
  runTerminalToolTest,
  runProjectFilesTest,
  runExtensionSdkImportTest,
  runExtensionReloadTest,
  runExtensionCommandContextTest,
  runResourceListingTest,
  runViewStateTest,
  runStartupSessionTest,
  runLiveToolCallTest,
  formatDiagnostics,
  resolveWorkspaceCwd,
};

/** Multi-root workspaces fall back to the first folder (selector comes later). */
function resolveWorkspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath ?? process.cwd();
}
