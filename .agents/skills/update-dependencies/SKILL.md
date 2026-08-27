---
name: update-dependencies
description: 检查并更新本项目（pi-agent-chat）的依赖版本。优先检查 @earendil-works/pi-ai 与 @earendil-works/pi-coding-agent 是否有新版本；若 Pi 相关依赖无新版本则跳过其余依赖检查。更新后运行项目验证并整理 Pi SDK 新功能吸收建议。当用户要求更新依赖、升级 Pi SDK、或检查依赖新版本时使用。
---

# update-dependencies

依赖版本规则以项目根目录 `AGENTS.md` 为准：`dependencies` 与 `devDependencies` 必须使用固定版本号。新增依赖由 `.npmrc` 的 `save-exact=true` 默认精确保存；本技能直接修改 `package.json` 中的版本字符串。

固定版本号不变式由项目脚本统一检查，开始更新前先运行：

```powershell
pnpm check:dependencies
```

若失败，先把违规声明固定为当前安装版本并运行 `pnpm install`，再继续检查更新。

## 步骤

### 1. 检查 Pi SDK 是否有新版本

```powershell
npm view @earendil-works/pi-coding-agent version
npm view @earendil-works/pi-ai version
```

与 `package.json` 中的当前版本比较。**两个包必须保持同一版本号**（上游同步发布）。

- 若无新版本：告知用户“Pi SDK 已是最新”，确认前置固定版本检查通过后**结束，不再检查其他依赖**。
- 若有新版本：继续。

### 2. 更新 Pi SDK

编辑 `package.json`，将 `@earendil-works/pi-ai` 与 `@earendil-works/pi-coding-agent` 的
`dependencies` 版本改为新版本，然后：

```powershell
pnpm install
```

注意：`undici` 是本仓库的显式直接依赖（`src/agent/http.ts` 装全局代理 dispatcher），esbuild `alias`
把 SDK 嵌套副本一并收敛到它。升级时必须同时满足 **>= 8.7.0**（代理转发修复）且 **>= SDK 自带版本**；
两者由 `scripts/check_bundle.py` 在 `pnpm verify` 里断言（见 AGENTS.md 已知陷阱）。

### 3. 检查其余依赖（仅当 Pi SDK 有更新时）

```powershell
pnpm outdated
```

对有新版本的依赖逐个评估：
- `diff`、`marked`：小版本/补丁可直接升；major 升级需查 changelog 的 breaking changes。
- `undici`：见上文，谨慎。
- devDependencies（esbuild、typescript、@vscode/vsce、@types/*、jsdom）：可跟进最新。
  `@types/vscode` 的 major.minor 不得超过 `engines.vscode`；`typescript` 对齐当前 VS Code 内置版本
  （`<VS Code 安装目录>/resources/app/extensions/node_modules/typescript/package.json`）。

注意：`pnpm outdated` 只列“已安装版本落后于 latest”的包，**看不到版本声明写法的问题**
（例：`^30.0.1` 当前恰好解析到 latest 时不会出现在输出里），因此不能只盯这张表，还要跑第 5 步的
固定版本号体检。

更新后再次 `pnpm install`。

### 4. 同步文案中的版本号（必做）

依赖升了，声称「当前内置版本」的文案不会自己跟着变，必须逐一同步。升级前先记下旧版本号，
升级后用它全文搜索：

```powershell
rg -n "<旧版本号>" README.md readme.zh-CN.md package.nls.json package.nls.zh-cn.json THIRD-PARTY-NOTICES.txt
```

已知承载版本号的位置：

- `README.md` / `readme.zh-CN.md`：正文「官方 SDK（v0.84.x）」。
- `package.nls.json` / `package.nls.zh-cn.json`：`extension.description`（Marketplace 简介由
  VS Code 渲染，拿不到 `t()`，只能走清单本地化，两份都要改）。
- `THIRD-PARTY-NOTICES.txt`：逐行列出的被打包运行时依赖及其版本。Pi 四个包之外，第 3 步
  升过的其他被打包依赖（如 `marked`）也要同步，逐一核对，不要只改第一处。

判定口径：**只更新描述「当前版本」的文案**。版本相对行为的注释与历史记录
（如 `src/**` 里「自 X 版本起」「X 之前」的说明、`docs/changelog/` 历史文件中的旧版本号）
保持原样——那是事实陈述，不是过期信息。

本次发布若包含依赖升级，`docs/changelog/<新版本>*.md` 的「升级」小节要列旧 → 新版本号。

### 5. 验证（必做）

先通过项目脚本体检不变式；不要在技能中另写一份判定逻辑，以免规则漂移：

```powershell
pnpm check:dependencies
```

退出码非 0 就把对应依赖写死为当前安装版本，再运行 `pnpm install`（lockfile 的 `specifier`
会跟着变，解析版本通常不变）。

然后跑构建与测试：

```powershell
pnpm build
pnpm typecheck
pnpm verify        # 构建产物校验 + 无头冒烟测试（含 SDK 加载、jiti、clipboard）
```

三者全部通过才算更新成功。若 `verify` 失败，重点排查：
- SDK 导出面变化（`import` 报错 / 类型不匹配）→ 对照新版本 `dist/index.d.ts` 调整调用方。
- OAuth 注册入口变化（`registerBunOAuthFlows`）→ 检查 `src/extension.ts` 与 esbuild.mjs。
- 需要真实 LLM 的冒烟：`$env:PI_SPIKE_LIVE="1"; node scripts/smoke_load.mjs`（消耗 token，可选）。

可选：`pnpm package:vsix` 后在 Extension Development Host（F5）里手动过一轮
prompt + 工具调用 + session 切换。

### 6. 整理 Pi SDK 新功能吸收建议

比较新旧版本，寻找插件可吸收的新能力：

```powershell
# changelog / release notes
npm view @earendil-works/pi-coding-agent
# 对比导出面
git diff --no-index <旧版本 index.d.ts> node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts
```

关注点：`AgentSession`/`AgentSessionRuntime` 新方法、新事件类型（bridge.ts 需要处理）、
`ModelRuntime` 认证能力变化、extension/skill 新钩子、新的内置斜杠命令（commands.ts 命名对齐 CLI）。

评估新能力时遵守 AGENTS.md 的「CLI 有、SDK 没导出」四类判定树，不要把 TUI 呈现特性或 SDK
内部 helper 搬进插件。

将发现整理为推荐列表报告给用户（功能名、SDK 提供的能力、插件侧需要的改动量），
**由用户决定**是否实现，不要擅自加功能。

### 7. 比对已镜像的 SDK 内部实现

插件作为应用入口复刻了少量 SDK 未导出的逻辑，这些地方不受类型检查保护，升级后必须人工比对。
它们统一用 `SDK-MIRROR:` 标记（专用 tag，避免与满屏“mirrors the CLI”的 UI 对齐注释混淆）：

```powershell
rg -n "SDK-MIRROR" src
```

逐一打开匹配到的注释，对照它指向的 SDK 源文件确认行为与默认值未变；若上游改了流程或默认值，
同步修改插件侧并在报告里说明。新增镜像时也要打上这个 tag。

## 完成后

向用户汇报：更新了哪些包（旧 → 新版本）、固定版本号体检结果、文案同步结果（改了哪些文件）、
验证结果、镜像实现比对结果、SDK 新功能推荐列表。
