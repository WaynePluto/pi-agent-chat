/**
 * 校验 VSIX 里不打 bundle 的包是否自给自足。
 * 必须单独校验：pi 扩展由 SDK 经 jiti 加载，`@earendil-works/pi-ai` 等解析到
 * dist/node_modules/ 的磁盘副本而非 bundle，副本自带的裸 import（partial-json、
 * yaml、chalk…）也得随包发行。缺口开发期不可见——Node 会向上找到仓库的
 * node_modules 兜底，只有 vsce package 剥掉根 node_modules 后才爆
 * "Cannot find module"，故要在仓库外沙箱重建发布布局再验（不读
 * dist/node_modules，陈旧副本会让校验因错误的原因通过）。
 * 入口 import 还不够：pi-ai 把 provider SDK 藏在 lazyApi(() => import(...)) 门面后，真正调用时顶层 import 才失败，故探针还要逐个 import pi-ai/dist/api/ 的全部 provider 模块。
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { copyRuntimePackages, extensionVisibleEntries, runtimePackages } from "./runtime-packages.mjs";

function fail(message) {
  console.error(`[fail] ${message}`);
  process.exit(1);
}

const sandbox = join(tmpdir(), `pi-vsix-runtime-${process.pid}`);
const target = join(sandbox, "dist", "node_modules");

try {
  await mkdir(dirname(target), { recursive: true });
  const { skipped } = await copyRuntimePackages(target);
  if (skipped.length > 0) fail(`runtime packages not installed: ${skipped.join(", ")}`);

  const missingEntries = extensionVisibleEntries.filter((entry) => !existsSync(join(target, entry)));
  if (missingEntries.length > 0) fail(`entry points missing from the shipped layout: ${missingEntries.join(", ")}`);

  // 用子进程跑探针：Node 不会缓存失败的 specifier 解析，坏掉的 SDK 也
  // 不会把本脚本一起带崩。
  const probe = join(sandbox, "probe.mjs");
  const providerModules = readdirSync(join(target, "@earendil-works", "pi-ai", "dist", "api"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => pathToFileURL(join(target, "@earendil-works", "pi-ai", "dist", "api", name)).href);
  await writeFile(
    probe,
    [
      ...extensionVisibleEntries.map((entry) => `await import(${JSON.stringify(pathToFileURL(join(target, entry)).href)});`),
      ...providerModules.map((href) => `await import(${JSON.stringify(href)});`),
    ].join("\n"),
    "utf8",
  );

  try {
    execFileSync(process.execPath, [probe], { stdio: "pipe" });
  } catch (error) {
    const output = `${error.stderr ?? ""}${error.stdout ?? ""}`;
    const missing = /Cannot find (?:package|module) '([^']+)'/.exec(output);
    if (missing) {
      fail(
        `on-disk SDK cannot resolve '${missing[1]}' — add it to runtimePackages in scripts/runtime-packages.mjs.\n` +
          "       Extensions import the SDK from disk via jiti, so its dependencies must ship too.",
      );
    }
    fail(`loading the on-disk SDK failed:\n${output.split("\n").slice(0, 8).join("\n")}`);
  }

  console.log(
    `[ok]   ${runtimePackages.length} unbundled packages self-sufficient ` +
      `(${extensionVisibleEntries.length} SDK entries + ${providerModules.length} provider modules load)`,
  );
} finally {
  await rm(sandbox, { recursive: true, force: true }).catch(() => {});
}
