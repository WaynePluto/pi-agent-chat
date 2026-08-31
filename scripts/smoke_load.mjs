/**
 * Load-time smoke test for the bundled extension.
 *
 * Runs `dist/extension.js` in plain Node with a stubbed `vscode` module to catch
 * bundling failures (missing externals, ESM->CJS issues) before launching an
 * Extension Development Host.
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
  // The host always provides a display language; localized strings read it.
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

/** Report a diagnostic batch and remember whether anything failed. */
let failures = 0;
function report(results) {
  failures += results.filter((result) => !result.ok).length;
  console.log(formatDiagnostics(results));
}

const { DIAGNOSTIC_SUITES, runLiveToolCallTest, formatDiagnostics } = extension.__spike;

// One list, defined in `src/agent/diagnostics.ts`: a self-check added there
// runs here and in the VS Code command without touching either runner.
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
