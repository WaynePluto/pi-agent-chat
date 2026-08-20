/**
 * Replay fixtures for the VS Code terminal tool (`src/agent/terminal-replay.ts`).
 *
 * The replay is the only part of that tool with real logic, and it fails
 * *silently*: a broken cursor operation does not throw, it hands the model
 * plausible-looking text that never appeared on screen. So the cases are
 * checked on every `pnpm verify` rather than only when someone runs the spike
 * in a real window.
 *
 * The module is compiled here with esbuild rather than imported as `.ts`
 * directly: Node's type stripping only exists from 22.18, and this repository
 * declares `node >=20`. esbuild is already a dev dependency and already runs
 * earlier in `verify`, so this adds no new tooling. Nothing from the extension
 * bundle is loaded — the module is deliberately free of `vscode` imports so it
 * can be tested exactly like this.
 */
import { build } from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const entry = resolve(root, "src", "agent", "terminal-replay.ts");

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const output = result.outputFiles[0];
if (!output) {
  console.error("[fail] terminal replay module produced no output");
  process.exit(1);
}

const module = await import(`data:text/javascript;base64,${Buffer.from(output.text).toString("base64")}`);
const { REPLAY_CASES, findReplayFailures } = module;

const failures = findReplayFailures();
for (const { testCase, actual } of failures) {
  console.error(`[fail] ${testCase.name}`);
  console.error(`       expected text  ${JSON.stringify(testCase.expected)}`);
  console.error(`       actual text    ${JSON.stringify(actual.text)}`);
  if (testCase.expectedCursorLine !== undefined) {
    console.error(`       expected cursor line ${testCase.expectedCursorLine}, actual ${actual.cursorLine}`);
  }
}

if (failures.length > 0) {
  console.error(`[fail] ${failures.length}/${REPLAY_CASES.length} terminal replay case(s) failed`);
  process.exit(1);
}

console.log(`[ok]   ${REPLAY_CASES.length} terminal replay case(s) reproduce the screen exactly`);
