# AGENTS.md — pi-agent-chat

非官方 VS Code 插件：在侧边栏提供 pi coding agent 的聊天 UI。插件只做 UI 层，agent 能力全部来自官方 SDK `@earendil-works/pi-coding-agent`。

## 架构速览

- `src/extension.ts` — 插件入口：注册 webview view（`piAgentChat.view`）、命令、诊断；`ChatViewProvider` 懒启动 `PiRuntime` + `ChatBridge`。
- `src/agent/runtime.ts` — SDK `AgentSessionRuntime` 薄封装；负责 session 新建/切换/fork 与 extension 重绑定。
- `src/agent/bridge.ts` — 双向翻译层：SDK 事件 → `HostMessage`，webview 消息 → runtime 操作；session 历史回放。
- `src/agent/auth.ts` — 登录/登出流程：`ModelRuntime.login()` + `AuthInteraction` 映射到 VS Code 原生对话框。
- `src/agent/commands.ts` — 斜杠命令目录与内置命令分发（命名对齐 CLI）。
- `src/shared/protocol.ts` — host ↔ webview 消息协议，**必须保持零依赖**（webview 打包不能引入 Node 代码）。
- `src/webview/` — webview 前端（无框架，DOM 直操作）；`i18n.ts` 提供 zh/en 双语。
- `media/main.css` — 样式，颜色只用 VS Code 主题变量。

## 关键约定

- 会话文件与配置完全复用 `~/.pi/agent/`（auth.json、models.json、settings、extensions、skills），与终端 pi 可互操作；不要引入插件私有的配置副本。
- 每次 `runtime.session` 被替换（new/resume/fork/tree）后必须重新 `bindExtensions()` 并重订阅事件 —— 走 `ChatBridge.attach()`。
- 不要与终端 pi 同时 resume 同一个 session（JSONL 追加写无锁）。
- protocol.ts 修改后需同步 host 端（bridge）与 webview 端（main.ts）两侧。
- UI 文案改动要同时更新 `i18n.ts` 的 en 与 zh 两套字典。

## 构建与验证

```powershell
pnpm build          # esbuild -> dist/extension.js + dist/webview.js
pnpm typecheck      # tsc --noEmit
pnpm verify         # 构建 + bundle 校验 + 无头冒烟测试
pnpm package:vsix   # 打包 vsix
```

改完代码至少跑 `pnpm build` 和 `pnpm typecheck`。涉及 SDK 加载/打包的改动跑 `pnpm verify`。

## 已知陷阱

- OAuth flow 需在入口静态注册（`registerBunOAuthFlows()`），bundler 无法跟踪 SDK 的动态 import。
- undici 版本被 override 锁定（代理修复），不要随意升级。
- webview CSP 严格：脚本必须带 nonce，样式/图片只允许 `webview.cspSource`。
