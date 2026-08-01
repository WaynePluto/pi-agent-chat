---
name: update-dependencies
description: 检查并更新本项目（pi-agent-chat）的依赖版本。优先检查 @earendil-works/pi-ai 与 @earendil-works/pi-coding-agent 是否有新版本；若 pi 相关依赖无新版本则跳过其余依赖检查。更新后运行项目验证并整理 pi SDK 新功能吸收建议。当用户要求更新依赖、升级 pi SDK、或检查依赖新版本时使用。
---

# update-dependencies

本项目所有依赖使用**固定版本号**（无 `^`/`~`），更新时直接改 `package.json` 中的版本字符串。

## 步骤

### 1. 检查 pi SDK 是否有新版本

```powershell
npm view @earendil-works/pi-coding-agent version
npm view @earendil-works/pi-ai version
```

与 `package.json` 中的当前版本比较。**两个包必须保持同一版本号**（上游同步发布）。

- 若无新版本：告知用户“pi SDK 已是最新”，**结束，不再检查其他依赖**。
- 若有新版本：继续。

### 2. 更新 pi SDK

编辑 `package.json`，将 `@earendil-works/pi-ai` 与 `@earendil-works/pi-coding-agent` 的
`dependencies` 版本改为新版本，然后：

```powershell
pnpm install
```

注意：`undici` 被 `pnpm.overrides` 锁定为修复代理的版本，**不要**因 SDK 升级而顺手改动它，
除非确认新 undici 版本 >= 当前锁定版本且包含代理转发修复（见 AGENTS.md 已知陷阱）。

### 3. 检查其余依赖（仅当 pi SDK 有更新时）

```powershell
pnpm outdated
```

对有新版本的依赖逐个评估：
- `diff`、`marked`：小版本/补丁可直接升；major 升级需查 changelog 的 breaking changes。
- `undici`：见上文，谨慎。
- devDependencies（esbuild、typescript、@vscode/vsce、@types/*）：可跟进最新。
  `@types/vscode` 的 major.minor 不得超过 `engines.vscode`。

更新后再次 `pnpm install`。

### 4. 验证（必做）

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

### 5. 整理 pi SDK 新功能吸收建议

比较新旧版本，寻找插件可吸收的新能力：

```powershell
# changelog / release notes
npm view @earendil-works/pi-coding-agent
# 对比导出面
git diff --no-index <旧版本 index.d.ts> node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts
```

关注点：`AgentSession`/`AgentSessionRuntime` 新方法、新事件类型（bridge.ts 需要处理）、
`ModelRuntime` 认证能力变化、extension/skill 新钩子、新的内置斜杠命令（commands.ts 命名对齐 CLI）。

将发现整理为推荐列表报告给用户（功能名、SDK 提供的能力、插件侧需要的改动量），
**由用户决定**是否实现，不要擅自加功能。

## 完成后

向用户汇报：更新了哪些包（旧 → 新版本）、验证结果、SDK 新功能推荐列表。
