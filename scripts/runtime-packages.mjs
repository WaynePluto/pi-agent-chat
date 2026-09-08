/**
 * 不打进 bundle、随 `dist/node_modules/` 发行的包及其拷贝规则的唯一事实源。
 * 这些包没法 bundle：SDK 的扩展加载器交给 jiti 一组锚在 SDK 入口
 * `import.meta.url` 上的 alias，pi 扩展的 `import "@earendil-works/pi-ai"`
 * 因此解析到真实文件系统而非 esbuild 产物；磁盘副本反过来 import 的东西
 * 也必须同样存在于磁盘。
 * esbuild.mjs（生产构建时执行拷贝）与 scripts/check_extension_runtime.mjs
 * （证明清单完整）共用本文件。
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * pi 扩展允许 import 的入口（SDK 的 jiti alias 指向它们）。
 * 任何扩展要能加载，这些入口就必须先在磁盘上可解析。
 */
export const extensionVisibleEntries = [
  "@earendil-works/pi-coding-agent/dist/index.js",
  "@earendil-works/pi-agent-core/dist/index.js",
  "@earendil-works/pi-ai/dist/index.js",
  "@earendil-works/pi-tui/dist/index.js",
];

export const runtimePackages = [
  "@earendil-works/pi-coding-agent",
  // 由 SDK 的扩展加载器从磁盘解析（jiti alias 锚在 SDK 入口的
  // import.meta.url 上）：扩展在运行时 import 它们。
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-ai",
  "typebox",
  "jiti",
  "@silvia-odwyer/photon-node",
  "@mariozechner/clipboard",
  // 供应商 SDK：pi-ai 把每个都包在 `lazyApi(() => import(...))` 门面后，所以
  // 下面的入口探针加载不到它们——可一旦有人经这份磁盘副本调用 api（比如扩展
  // 流式取补全），它们就会被触达，届时各模块在顶层 import 自己的 SDK。
  // openai 还支撑 azure-openai-responses、openai-responses、openrouter-images
  // 与所有 Mistral 兼容 api。
  "openai",
  "@anthropic-ai/sdk",
  // anthropic SDK 的 webhooks 资源在顶层 require 它（provider 模块一被
  // import 就带进来）；另加它的两个 crypto 辅助包。
  "standardwebhooks",
  "@stablelib/base64",
  "fast-sha256",
  "@google/genai",
  // @google/genai 的提升闭包（auth + websocket + protobuf）。
  "google-auth-library",
  "base64-js",
  "buffer-equal-constant-time",
  "ecdsa-sig-formatter",
  "gaxios",
  "gcp-metadata",
  "google-logging-utils",
  "extend",
  "jws",
  "jwa",
  "safe-buffer",
  "node-fetch",
  "json-bigint",
  "bignumber.js",
  "p-retry",
  "protobufjs",
  "@protobufjs/aspromise",
  "@protobufjs/base64",
  "@protobufjs/codegen",
  "@protobufjs/eventemitter",
  "@protobufjs/fetch",
  "@protobufjs/float",
  "@protobufjs/path",
  "@protobufjs/pool",
  "@protobufjs/utf8",
  "long",
  "ws",
  "@aws-sdk/client-bedrock-runtime",
  // bedrock-converse-stream.js 在顶层 import 的包。
  "@smithy/node-http-handler",
  "http-proxy-agent",
  "https-proxy-agent",
  "debug",
  "ms",
  "agent-base",
  // @aws-sdk/client-bedrock-runtime 的提升闭包（其模块一被 import 就加载）。
  // 完整性由 scripts/check_extension_runtime.mjs 的 provider 模块探针强制：
  // 升级新引入的包会让 `pnpm verify` 报 "add it to runtimePackages"。
  "@aws-sdk/core",
  "@aws-sdk/credential-provider-env",
  "@aws-sdk/credential-provider-http",
  "@aws-sdk/credential-provider-ini",
  "@aws-sdk/credential-provider-login",
  "@aws-sdk/credential-provider-node",
  "@aws-sdk/credential-provider-process",
  "@aws-sdk/credential-provider-sso",
  "@aws-sdk/credential-provider-web-identity",
  "@aws-sdk/eventstream-handler-node",
  "@aws-sdk/middleware-eventstream",
  "@aws-sdk/middleware-websocket",
  "@aws-sdk/nested-clients",
  "@aws-sdk/signature-v4-multi-region",
  "@aws-sdk/token-providers",
  "@aws-sdk/types",
  "@aws-sdk/util-locate-window",
  "@aws-sdk/xml-builder",
  "@aws-crypto/sha256-browser",
  "@aws-crypto/sha256-js",
  "@aws-crypto/supports-web-crypto",
  "@aws-crypto/util",
  "@aws/lambda-invoke-store",
  "@smithy/core",
  "@smithy/credential-provider-imds",
  "@smithy/fetch-http-handler",
  "@smithy/is-array-buffer",
  "@smithy/signature-v4",
  "@smithy/types",
  "@smithy/util-buffer-from",
  "@smithy/util-utf8",
  "tslib",
  // 上面各 SDK 包的传递依赖。bundle 覆盖不到它们：扩展的
  // `import "@earendil-works/pi-ai"` 经 jiti 落到磁盘副本，副本自己的
  // `import "partial-json"` 只能对 dist/node_modules 解析、没有兜底可退。
  // 缺了它们，任何碰到 SDK 的扩展都死于 "Cannot find module"。
  // SDK harness 层的运行时依赖（agent-core 在顶层再导出其 context 辅助）。
  // SDK 的入口闭包只触达 `chord/context` 与主入口，esbuild 版 `chord/node`
  // 打包器触达不到，故 esbuild 本身无需随包发行。
  "@earendil-works/chord",
  "@earendil-works/pi-telemetry",
  "balanced-match",
  "brace-expansion",
  "chalk",
  "cross-spawn",
  "diff",
  "get-east-asian-width",
  "glob",
  "graceful-fs",
  "grok-mermaid",
  "highlight.js",
  "hosted-git-info",
  "ignore",
  "isexe",
  "lru-cache",
  "marked",
  "minimatch",
  "partial-json",
  "path-key",
  "proper-lockfile",
  "retry",
  "semver",
  "shebang-command",
  "shebang-regex",
  "signal-exit",
  "undici",
  "which",
  "yaml",
];

/**
 * 运行时包从哪里拷。
 * 这份清单服务的是磁盘上的 SDK 副本，每个包都得按那份副本的解析方式取。
 * hoisted 的 pnpm 布局下，插件自己的直接依赖占住根位置，把 SDK 要的版本挤进
 * 嵌套 node_modules，故根位置不总是正确的来源。
 * highlight.js 是活例：webview 打 11.x 做语法高亮，SDK 需要 10.x，而 11.x 已
 * 不再导出 SDK 所用的 ./lib/index.js 深导入——拷根版本会让磁盘 SDK 加载不了。
 * 插件自己那份进了 bundle、永不从磁盘读，所以必须发行 SDK 的版本。
 */
function runtimePackageSource(name) {
  const nested = resolve(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", name);
  return existsSync(nested) ? nested : resolve(repoRoot, "node_modules", name);
}

/** 原生剪贴板绑定装在按平台划分的兄弟包里。 */
export function platformClipboardPackages() {
  const manifest = resolve(repoRoot, "node_modules", "@mariozechner", "clipboard", "package.json");
  try {
    return Object.keys(JSON.parse(readFileSync(manifest, "utf8")).optionalDependencies ?? {});
  } catch {
    return [];
  }
}

/**
 * 把运行时包拷入 `target`。
 * 嵌套 node_modules 是故意丢弃的：保留会让包在本地满足自己的依赖，把
 * runtimePackages 里缺失的条目藏起来——那正是这套布局要排除的失败。
 */
export async function copyRuntimePackages(target, { log = () => {} } = {}) {
  await rm(target, { recursive: true, force: true });
  const skipped = [];
  for (const name of runtimePackages) {
    const source = runtimePackageSource(name);
    try {
      await mkdir(dirname(join(target, name)), { recursive: true });
      await cp(source, join(target, name), {
        recursive: true,
        // 类型声明与 sourcemap 在运行时是死重。
        filter: (path) => {
          const rel = path.slice(source.length);
          if (/[\\/]node_modules[\\/]|\.map$|\.d\.ts$|\.d\.mts$|\.d\.cts$|\.md$/.test(rel)) return false;
          // clipboard 的 npm 壳带 Rust 源码与构建文件，运行时永远用不上；
          // 只保留 JS loader 与清单。
          if (source === resolve(repoRoot, "node_modules", "@mariozechner", "clipboard")) {
            if (/[\\/]src[\\/]|Cargo\.toml$|build\.rs$|exp\.ts$|\.yarnrc\.yml$/.test(rel)) return false;
          }
          return true;
        },
      });
    } catch (error) {
      skipped.push(name);
      log(`skipped runtime package ${name}: ${error.message}`);
    }
  }
  for (const name of platformClipboardPackages()) {
    try {
      await cp(resolve(repoRoot, "node_modules", name), join(target, name), { recursive: true });
    } catch {
      // 其他平台对应的可选依赖；不存在时忽略。
    }
  }
  return { skipped };
}

