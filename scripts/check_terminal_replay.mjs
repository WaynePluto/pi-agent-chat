/**
 * VS Code 终端工具（src/agent/terminal-replay.ts）的重放用例。
 * 重放是该工具唯一有真实逻辑的部分，且会静默失败：坏掉的光标操作不抛错，
 * 只会把屏幕上从未出现的、貌似合理的文本交给模型，所以用例要在每次
 * `pnpm verify` 里跑，而不是只靠有人在真窗口里跑 spike。
 * 模块在这里用 esbuild 编译而不是直接 import .ts：Node 的类型剥离 22.18 才
 * 有，而仓库声明 `node >=20`；esbuild 已是 dev 依赖且已在 verify 前面跑过。
 * 模块故意不含 vscode import，正好这样单独加载，完全不碰扩展 bundle。
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
