/**
 * Webview 特征测试（characterization test）。
 *
 * 在 jsdom 里加载构建产物 `dist/webview.js`，回放固定序列的 HostMessage，
 * 并对结果 DOM 结构做快照。快照是 webview 重构的安全网：transcript、
 * composer、会话页或资源面板渲染的任何非预期变化都会体现为 diff。
 *
 *   node scripts/smoke_webview.mjs            # 与基线比对
 *   node scripts/smoke_webview.mjs --update   # 重写基线（先审 diff！）
 *
 * 有意不依赖任何断言框架：整个项目的测试策略就是「无头跑一遍、比对输出」。
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./smoke_webview/harness.mjs";

// 会话时间戳按本机时区渲染，不固定的话基线会因开发者而异。在任何
// 构造 Date 的代码之前钉住；UTC 让记录值与 fixture 相等。
process.env.TZ = "UTC";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(root, "dist", "webview.js");
const baselinePath = join(root, "scripts", "webview-snapshot.txt");
const update = process.argv.includes("--update");

await run({ bundlePath, baselinePath, update });
