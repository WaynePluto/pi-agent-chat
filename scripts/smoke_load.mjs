/**
 * 扩展 bundle 的加载期冒烟测试。
 * 在纯 Node 里用桩 vscode 模块跑 dist/extension.js，在启动 Extension
 * Development Host 之前抓住打包失败（external 缺失、ESM→CJS 问题）。
 */
import Module from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const bundle = resolve(root, "dist", "extension.js");

const disposable = { dispose() {} };
const noop = () => disposable;
const vscodeStub = {
  Uri: { file: (path) => ({ fsPath: path, path }), joinPath: (base, ...parts) => ({ fsPath: [base?.fsPath, ...parts].join("/") }) },
  EventEmitter: class {},
  ProgressLocation: { Notification: 15 },
  // 宿主总会提供显示语言；本地化文案要读它。
  env: { language: "en", clipboard: { writeText: async () => {} }, openExternal: async () => true },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    registerWebviewViewProvider: noop,
    registerWebviewPanelSerializer: noop,
    showErrorMessage: noop,
    showWarningMessage: noop,
    showInformationMessage: noop,
    showQuickPick: noop,
    showInputBox: noop,
    showTextDocument: noop,
    withProgress: (_options, task) => task(),
  },
  commands: { registerCommand: noop, executeCommand: noop },
  languages: { setTextDocumentLanguage: async (document) => document },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: root } }],
    openTextDocument: noop,
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: noop,
    onDidSaveTextDocument: noop,
    registerTextDocumentContentProvider: noop,
    fs: { readFile: async () => new Uint8Array() },
  },
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function patched(request, ...rest) {
  if (request === "vscode") return "vscode";
  return originalResolve.call(this, request, ...rest);
};
const originalLoad = Module._load;
Module._load = function patched(request, ...rest) {
  if (request === "vscode") return vscodeStub;
  return originalLoad.call(this, request, ...rest);
};

const require = Module.createRequire(import.meta.url);
const extension = require(bundle);

const subscriptions = [];
extension.activate({
  subscriptions,
  extensionUri: { fsPath: root },
  extensionPath: root,
  workspaceState: { get: () => undefined, update: async () => {} },
});

if (typeof extension.activate !== "function" || typeof extension.deactivate !== "function") {
  console.error("[fail] bundle does not export activate/deactivate");
  process.exit(1);
}

console.log(`[ok]   bundle loaded and activated (${subscriptions.length} subscriptions registered)`);

/** 汇报一批诊断结果，并记下是否有失败。 */
let failures = 0;
function report(results) {
  failures += results.filter((result) => !result.ok).length;
  console.log(formatDiagnostics(results));
}

const { DIAGNOSTIC_SUITES, runLiveToolCallTest, formatDiagnostics } = extension.__spike;

// 唯一的一份清单，定义在 src/agent/diagnostics.ts：在那边新增自检项后，
// 这里与 VS Code 命令两个 runner 都会跑，两边都不用改。
for (const suite of DIAGNOSTIC_SUITES) report(await suite(root));

if (process.env.PI_SPIKE_LIVE === "1") {
  console.log("\n# Live prompt + tool call");
  report(await runLiveToolCallTest(root, (message) => console.log(`       ${message}`)));
}

extension.deactivate();

if (failures > 0) {
  console.error(`[fail] ${failures} diagnostic(s) failed`);
  process.exit(1);
}
