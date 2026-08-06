# AGENTS.md — pi-agent-chat

非官方 VS Code 插件：在侧边栏提供 Pi Coding Agent 的聊天 UI。插件只做 UI 层，agent 能力全部来自官方 SDK `@earendil-works/pi-coding-agent`。

## 架构速览

- `src/extension.ts` — 插件入口：注册 webview view（`piAgentChat.view`）、命令、诊断；`ChatViewProvider` 懒启动 `PiRuntime` + `ChatBridge`。
- `src/agent/runtime.ts` — SDK `AgentSessionRuntime` 薄封装；负责 session 新建/切换/fork 与 extension 重绑定。
- `src/agent/bridge.ts` — 双向翻译层：SDK 事件 → `HostMessage`，webview 消息 → runtime 操作；session 历史回放。
- `src/agent/auth.ts` — 登录/登出流程：`ModelRuntime.login()` + `AuthInteraction` 映射到 VS Code 原生对话框。
- `src/agent/commands.ts` — 斜杠命令目录与内置命令分发（命名对齐 CLI）。
- `src/agent/model-picker.ts` — 模型选择器与 `/scoped-models`：常用模型置顶，行内 ⭐ 单独设置常用模型、📌 设置默认模型，批量勾选结果写入共享设置 `enabledModels`。
- `src/agent/skills.ts` — 技能路径索引：把 `read`/`bash` 调用判定为「加载技能」或「技能资源」，供 transcript 与资源面板区分展示。
- `src/shared/protocol.ts` — host ↔ webview 消息协议与共享常量，**必须保持零依赖**（webview 打包不能引入 Node 代码）。
- `src/shared/messages.ts` — 宿主侧文案的中英字典（含参数化模板），同样零依赖；宿主经 `agent/i18n.ts` 的 `t()`/`tf()` 取用，webview `i18n.ts` 也引用它以保持措辞一致。
- `src/webview/` — webview 前端（无框架，DOM 直操作），按面板拆分：`main.ts` 只做布局/接线/路由，`transcript.ts`、`composer.ts`、`sessions-view.ts`、`resources-view.ts`、`statusline.ts` 各管一块，`shell.ts`/`store.ts`/`host.ts`/`collapsible.ts`/`dom.ts` 为公共设施；`i18n.ts` 提供 zh/en 双语。
- `media/main.css` — 样式，颜色只用 VS Code 主题变量。

项目模块架构见 `ARCHITECTURE.md`；修改模块结构后请更新该文件。

## 关键约定

- 会话文件与配置完全复用 `~/.pi/agent/`（auth.json、models.json、settings、extensions、skills），与终端 Pi 可互操作；不要引入插件私有的配置副本。常用模型同理：只读写全局 settings 的 `enabledModels`，语义对齐 CLI `/scoped-models`（显式 `provider/modelId` 列表，全选或空则清空该项）。
- 有意偏离 CLI 的一处：SDK 的 `AgentSession.setModel()` 会顺带改写 `defaultProvider`/`defaultModel`（CLI 语义是「选中即设为默认」）。插件把两者分开——切换模型只影响当前会话，默认模型只由模型选择器行内的 📌 按钮设置——所以 `PiRuntime.setModel()` 在调用后会把原默认值写回。改动这一段前先确认该语义。
- 每次 `runtime.session` 被替换（new/resume/fork/tree）后必须重新 `bindExtensions()` 并重订阅事件 —— 走 `ChatBridge.attach()`。
- 不要与终端 Pi 同时 resume 同一个 session（JSONL 追加写无锁）。
- protocol.ts 修改后需同步 host 端（bridge）与 webview 端（main.ts）两侧。
- UI 文案改动要同时更新 `i18n.ts` 的 en 与 zh 两套字典；宿主侧面向用户的文案（原生对话框、QuickPick、transcript 状态提示）全部放在 `src/shared/messages.ts`，通过 `agent/i18n.ts` 的 `t()` / `tf()` 取用，不要在代码里内联英文字面量或 `startsWith("zh")` 判断。有意不本地化的三类：`/` 命令目录（对齐 CLI）、spike 诊断命令（开发者工具）、SDK/模型产生的文本。
- webview 端改动后 `pnpm verify` 会比对 `scripts/webview-snapshot.txt` 的 DOM 快照；差异即回归信号，确认无误后用 `node scripts/smoke_webview.mjs --update` 更新基线并在 commit 中说明。

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
