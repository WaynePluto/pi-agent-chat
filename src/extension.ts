import * as vscode from "vscode";
// 打包构建必须静态注册 OAuth flow：SDK 把它们藏在变量 specifier 后面，
// bundler 跟踪不到（见 esbuild.mjs）。
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import {
  DIAGNOSTIC_SUITES,
  formatDiagnostics,
  runAllDiagnostics,
  runLiveToolCallTest,
} from "./agent/diagnostics.js";
import { OriginalContentProvider, ORIGINAL_SCHEME } from "./agent/diff-view.js";
import { configureHttpProxy } from "./agent/http.js";
import { runTerminalIntegrationSpike } from "./agent/terminal-spike.js";
import { CHAT_PANEL_TYPE, CHAT_VIEW_ID, ChatSurfaceManager } from "./chat-surfaces.js";

export function activate(context: vscode.ExtensionContext): void {
  // SDK-MIRROR: dist/cli.js 进入时设置这些，rpc-entry.js 重复 PI_CODING_AGENT
  // ——应用入口职责，不是 CLI 装饰。扩展与 `bash` 工具跑的东西靠它们识别自己
  // 在 agent 里（分页器、颜色、提示符）。cli.js 其余部分刻意不镜像：
  // process.title 与 emitWarning 在这里归 VS Code，HTTP dispatcher 由下面的
  // agent/http.ts 配置。
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
      const results = await runAllDiagnostics(resolveWorkspaceCwd());
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
 * 为 `scripts/smoke_load.mjs` 重导出：该脚本在纯 Node（桩掉 `vscode` 模块）
 * 里跑 bundle。不属于扩展的公开面。
 */
export const __spike = {
  DIAGNOSTIC_SUITES,
  runLiveToolCallTest,
  formatDiagnostics,
  resolveWorkspaceCwd,
};

/** multi-root 工作区回退到第一个文件夹（选择器以后再做）。 */
function resolveWorkspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath ?? process.cwd();
}
