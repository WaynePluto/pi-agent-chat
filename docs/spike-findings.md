# 打包与 SDK 适配说明

记录让官方 SDK `@earendil-works/pi-coding-agent` 在打包后的 VS Code 插件里正常工作所需的插件层适配，及各适配点的实测依据（最初在里程碑 1 的 Spike 阶段验证）。
全部适配都在插件层完成，未修改 SDK 源码、未 fork。

验证环境：`@earendil-works/pi-coding-agent@0.83.0`，pnpm 10，Node 22，VS Code 1.131。

## 1. 结论速览

| 风险点 | 结论 | 处理方式 |
| --- | --- | --- |
| undici proxy bug | 需要修复，npm 上 0.83.0 仍 pin `undici@8.5.0` | pnpm `overrides` + esbuild `alias`（双保险） |
| sqlite 原生依赖 | 不存在，SDK 无 sqlite 依赖 | 无需处理 |
| 原生模块 `@mariozechner/clipboard` | 可加载（optionalDependency） | 保持 external，随 VSIX 发布 |
| jiti 加载 `.ts` extension | 可用 | 必须打包 `jiti/static`，不能 external |
| SDK 打包进 CJS bundle | 可行，但需 4 处适配 | 见第 3 节 |
| prompt + 工具调用闭环 | 通过（无头环境实测 bash 工具调用成功） | `scripts/smoke_load.mjs` |

## 2. undici：两层修复

npm 上的 `pi-coding-agent@0.83.0` 依赖 `undici@8.5.0`，且发布包自带 `npm-shrinkwrap.json`，
默认安装会在 `node_modules/@earendil-works/pi-coding-agent/node_modules/undici` 落一份 8.5.0。

1. **pnpm overrides**（`package.json` 的 `pnpm.overrides.undici = 8.8.0`）：实测可以穿透 SDK 的 shrinkwrap，
   安装后整棵树只剩一份 8.8.0。
2. **esbuild alias**（`esbuild.mjs`）：把 bundle 中所有 `import "undici"` 指向仓库顶层的 8.8.0。

两者独立生效，`scripts/check_bundle.py` 会校验 bundle 中只嵌入一份 undici 且版本 >= 8.7.0。

## 3. 打包 SDK 需要的 4 处插件层适配

SDK 是 ESM 包，VS Code 插件入口必须是 CJS，因此 bundle 采用 `format: "cjs"`，由此引出：

### 3.1 `import.meta.url` 失效

SDK 的 `config.js` 用 `fileURLToPath(import.meta.url)` 定位自身包目录（docs / examples / 资源文件）。
CJS 输出下 `import.meta` 为空对象，加载时直接抛 `ERR_INVALID_ARG_TYPE`。

处理：esbuild `banner` 注入 `__piSdkEntryUrl`（指向 VSIX 内 `node_modules/@earendil-works/pi-coding-agent/dist/index.js`），
并 `define` `import.meta.url` 为该常量。`getPackageDir()` 因此仍返回真实的 SDK 安装目录。

### 3.2 `jiti/static` 是 ESM-only 子路径

SDK 的 extension loader `import { createJiti } from "jiti/static"`，该子路径只有 `import` 条件导出，
一旦 external 就会在 CJS bundle 里变成 `require("jiti/static")` 并失败。

处理：不要把 `jiti` 放进 `external`，让它随 bundle 打包。实测 jiti 在 bundle 内可正常加载 `.ts` 文件。

### 3.3 OAuth flow 模块对打包器不可见

`@earendil-works/pi-ai` 故意用变量 specifier 动态 import OAuth 流程模块（`auth/oauth/*.js`），
打包后会退化成相对 bundle 目录的路径，导致 `OAuth auth derivation failed: Cannot find module .../dist/github-copilot.js`。

处理：SDK 为打包场景提供了公开入口 `@earendil-works/pi-ai/bun-oauth` 的 `registerBunOAuthFlows()`，
在 `activate()` 最开始调用即可把全部 OAuth flow 静态注册进 bundle。

### 3.4 代理 dispatcher 需要插件自己安装

CLI 在 `main.ts` 里调用 `configureHttpDispatcher()` 安装 `EnvHttpProxyAgent` 并 `undici.install()`，
但该函数不在 SDK 公开导出中；仅用 SDK 时 Node 内置 fetch 不读 `HTTP(S)_PROXY`，代理环境下表现为 `fetch failed`。

处理：`src/agent/http.ts` 用插件自带的 undici 安装全局 dispatcher，并优先采用 VS Code 的
`http.proxy` / `http.proxyStrictSSL` 设置。因为有 alias，插件与 SDK 共用同一份 undici 实例。

## 4. 已知限制

- Extension Development Host（Electron 42 / Node 24，VS Code 1.131）已人工验证：侧边栏收发消息正常，
  `Pi Agent Chat: Run Spike Diagnostics` 全部 `[ok]`，与无头结果一致。
- 图片相关能力（photon wasm、image-resize worker）未验证。
- `ExtensionUIContext` 仅实现 select / confirm / input / editor / notify，其余 TUI 专属能力由 no-op Proxy 兜底。
