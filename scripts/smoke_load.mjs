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

const {
  runSpikeDiagnostics,
  runHistoryReplayTest,
  runSlashCommandTest,
  runManualRetryTest,
  runReplayedRetryOfferTest,
  runSessionTreeTest,
  runSubagentToolTest,
  runProjectFilesTest,
  runExtensionSdkImportTest,
  runExtensionReloadTest,
  runExtensionCommandContextTest,
  runResourceListingTest,
  runStartupSessionTest,
  runLiveToolCallTest,
  formatDiagnostics,
} = extension.__spike;
report(await runSpikeDiagnostics());
report(await runHistoryReplayTest(root));
report(await runSlashCommandTest(root));
// Pins the private SDK entry point the "retry" action on a failed-request
// notice rides on, and that resuming re-issues the request without inventing a
// user message.
report(await runManualRetryTest(root));
// Pins the same offer on a transcript replayed from disk: a window that reopens
// a session which died mid-request must not leave the user with a dead end.
report(await runReplayedRetryOfferTest(root));
report(await runSessionTreeTest(root));
report(await runSubagentToolTest(root));
report(await runProjectFilesTest(root));
// Must run inside the bundle: it proves the rebuilt `import.meta.url` still
// lets the SDK hand jiti working aliases (see sdkModuleUrlPlugin in esbuild.mjs).
report(await runExtensionSdkImportTest(root));
// Pins that reloading resources rebuilds the session's extension runner
// instead of leaving it on the previously loaded instances.
report(await runExtensionReloadTest(root));
// Pins that extension command handlers can actually drive the session
// (`ctx.newSession()` and friends are host-supplied, not SDK defaults).
report(await runExtensionCommandContextTest(root));
report(await runResourceListingTest(root));
// Pins which session a window opens with: the remembered one, including the
// new-and-still-empty state that leaves no file on disk.
report(await runStartupSessionTest(root));

if (process.env.PI_SPIKE_LIVE === "1") {
  console.log("\n# Live prompt + tool call");
  report(await runLiveToolCallTest(root, (message) => console.log(`       ${message}`)));
}

extension.deactivate();

if (failures > 0) {
  console.error(`[fail] ${failures} diagnostic(s) failed`);
  process.exit(1);
}
