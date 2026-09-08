import * as vscode from "vscode";
import type { SurfaceKind } from "./types.js";

export function renderChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri, surface: SurfaceKind): string {
  const asset = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts));
  const scriptUri = asset("dist", "webview.js");
  const styleUri = asset("dist", "main.css");
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
  <body class="surface-${surface}">
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i += 1) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}
