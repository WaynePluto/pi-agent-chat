# Pi Agent Chat（非官方）

[English](./readme.md) | 简体中文

VS Code 侧边栏中的 [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) 聊天界面。

> **免责声明**：本插件为**非官方**社区项目，与上游 pi 项目及 Earendil Works **无任何隶属、授权或维护关系**，相关商标归各自所有者所有。使用风险自负。

- 插件只做 UI 层，agent 能力 100% 来自官方 SDK `@earendil-works/pi-coding-agent`，SDK 已打包进 VSIX —— **无需安装 pi CLI**。
- 复用 `~/.pi/agent/` 的全部配置（auth、models、settings、extensions、skills、prompts、AGENTS.md）与默认 sessions 目录，可与终端 pi 互相列出/恢复会话。
- 内置登录/登出流程：无可用模型时显示认证引导页，支持 OAuth 与 API key。
- 界面中英双语，跟随 VS Code 显示语言。

> 注意：不要与终端 pi 同时 resume 同一个 session，JSONL 追加写无锁会交错。

## 演示

<p align="center">
  <img src="./media/example1.gif" alt="Pi Agent Chat 初始界面" width="320">
  <img src="./media/example2.gif" alt="Pi Agent Chat 对话界面" width="320">
</p>

## 设计哲学

与 pi 本身一样，本插件保持精简：

- **只做 UI，能力来自官方 SDK。** 基于官方 `@earendil-works/pi-coding-agent` SDK 独立开发的 VS Code UI。Agent 循环、工具、LLM 调用、extension/skill 加载全部来自 SDK，未作任何修改；无需安装 pi 的 TUI/CLI 版本。
- **零 VS Code 配置。** 没有设置页，不往 `settings.json` 里加任何配置项。一切配置都按 pi 的方式放在 `~/.pi/agent/`，与终端 pi 共享，可直接手工编辑。
- **完整兼容 pi 生态。** 上下文（AGENTS.md）、skills、extensions、prompt 模板、模型与认证与 CLI 行为完全一致；会话可在插件与终端之间互通。UI 本身跟随 VS Code 颜色主题（不使用 pi 的 TUI 主题渲染）。
- **不堆功能。** 单会话模式、小而克制的功能面，只在真正有益处时接入 VS Code 原生能力（diff 视图、QuickPick、主题颜色）。

## 单会话模式（设计理念）

同一时间只有一条任务线在运行，运行期间不允许切换到无关会话或新建会话。主代理可以把一个任务串行委派给可见的 SDK 子会话：主代理等待，用户可在父/子 transcript 之间切换查看。不同 VS Code 窗口（不同项目）之间互不影响。

这是有意为之，不打算支持并行会话：

- AI 的开发速度已经足够快，绝大多数任务的瓶颈不在“等 AI”。
- 如果有多个任务，更好的方式是把它们写成一个任务列表一次性发给 AI，让它按顺序执行；或者排队逐个来。上下文集中在一个会话里，AI 对全局的把握反而更好。
- 会话运行期间，去喝杯咖啡、伸个懒腰，回来验收结果——比盯着多个并行会话来回切换更高效，也更省心。

## 功能

- 流式 markdown 渲染（marked + DOM 白名单净化，逐帧节流重绘）
- 工具卡片：参数摘要、输出折叠、edit 结果的精简 diff 着色
- edit 结果一键打开原生 `vscode.diff`（反向应用 patch 还原旧内容）与目标文件
- session 新建 / 列表 / 恢复 / 删除，并回放历史 transcript
- session 树导航：标题栏 **Tree** 按钮或 `/tree` 打开 QuickPick，可切换分支、从任意节点 fork、给节点打标签；`/fork` 从历史用户消息分叉（原文回填输入框），`/clone` 原位复制当前 session
- 斜杠命令补全：输入 `/` 弹出候选，覆盖内置命令、prompt 模板、extension 命令与 `/skill:*`，命名与描述对齐 CLI
- 模型与思考等级切换（QuickPick）、abort、steer / follow-up
- 消息区上方固定资源列表（Context / Skills / Prompts / Extensions），与 CLI 启动列表一致
- 启动时自动 continue 当前工作区最近的会话
- `@` 项目文件引用：在输入框输入 `@` 模糊搜索工作区文件（默认遵循 `.gitignore`；`Ctrl+→` 切换显示被忽略文件，并标记 ignored / 敏感文件）；选中文件显示为可移除 chip，发送时以相对路径纯文本附在消息后，由模型自行 `read`
- 可见、串行的 SDK 子代理：内置 `subagent` 工具无需 pi CLI 即可创建持久子会话；主代理等待，父/子 transcript 均可查看，并禁止嵌套和并行委派

### 支持子代理的 Skill

Skill 应检测能力而不是判断具体 UI：若当前提供 `subagent` 工具，就传入完整任务调用它；否则 CLI skill 可使用 `pi --print` 或自己的降级路径。Pi Agent Chat 不拦截 skill 命令，也不模拟 `pi` 可执行文件。

子代理运行时输入框只读，可单独停止；主代理仍可排队或插话，但消息只会在子代理返回后投递。若从主代理点击停止，则取消整条任务线。

待办：语法高亮、图片粘贴。

## 安装（自用）

```powershell
pnpm install
pnpm package:vsix                      # 生成 pi-agent-chat.vsix
code --install-extension pi-agent-chat.vsix --force
```

打包产物只包含运行时必需内容：bundle、样式，以及 `dist/node_modules/` 下的 SDK 包目录（提供 docs/examples/主题等资源路径）、photon-node 与原生剪贴板。剪贴板原生包是平台相关的，在哪个平台打包就只带哪个平台的二进制。

## 开发

```powershell
pnpm install
pnpm build          # dist/extension.js + dist/webview.js
pnpm typecheck
pnpm verify         # 构建产物校验 + 无头冒烟测试
```

在 VS Code 中按 `F5`（Run Extension）启动 Extension Development Host，然后：

1. 打开活动栏的 **Pi Agent Chat** 视图，输入 prompt。
2. 命令面板运行 `Pi Agent Chat: Run Spike Diagnostics` 查看运行时风险点报告。
3. 命令面板运行 `Pi Agent Chat: Run Spike Live Test`（会真实调用 LLM，消耗 token）验证一轮 prompt + 工具调用。

无头冒烟测试（不需要 VS Code，`vscode` 模块被打桩）：

```powershell
pnpm verify                       # 仅静态检查 + 诊断
$env:PI_SPIKE_LIVE="1"; node scripts/smoke_load.mjs   # 额外跑一次真实 prompt
```

## 架构速览

- `src/extension.ts` — 入口：webview view、命令、诊断
- `src/agent/runtime.ts` — SDK `AgentSessionRuntime` 薄封装
- `src/agent/bridge.ts` — 双向翻译层：SDK 事件 ↔ webview 消息
- `src/agent/auth.ts` — 登录/登出映射到 VS Code 原生对话框
- `src/agent/subagent.ts` — 串行 SDK 子会话协调与 `subagent` 工具
- `src/shared/protocol.ts` — host ↔ webview 消息协议（零依赖）
- `src/webview/` — 前端（无框架，DOM 直操作）

打包与 SDK 适配说明（undici override 原因、`import.meta.url` 注入、OAuth flow 静态注册等）见 `docs/spike-findings.md`。

## 许可证

[MIT](./LICENSE)。注意：随包打入的 `@earendil-works/pi-coding-agent` SDK 及其依赖遵循各自的许可条款。
