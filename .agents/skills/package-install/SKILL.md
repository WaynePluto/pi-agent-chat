---
name: package-install
description: 把本项目（pi-agent-chat）打包成 vsix 并安装到本机 VS Code。当用户要求打包插件、生成 vsix、安装到本机、更新本地插件版本或“打包并安装”时使用。仅适用于本仓库，不适用于发布到 Marketplace。
---

# package-install

在本仓库内完成「验证 → 打包 vsix → 安装到本机 VS Code → 提示重载」的完整流程。
所有命令用 PowerShell 7 语法，在**项目根目录**（含 `package.json` 的仓库根）执行。

## 步骤

### 1. 验证（必做，失败即停止）

```powershell
pnpm typecheck
pnpm verify        # 内含 build + bundle 校验 + 无头冒烟 + webview DOM 快照比对
```

- `verify` 已包含构建，无需再单独 `pnpm build`。
- 若 webview 快照不一致：这是回归信号，**先向用户确认**改动是否符合预期，
  确认后再 `node scripts/smoke_webview.mjs --update` 更新基线，不要静默跳过。
- 任一步失败：报告失败原因并停止，不要打包安装未通过验证的产物。

### 2. 打包 vsix

```powershell
pnpm package:vsix
```

输出固定为项目根目录的 `pi-code-agent-chat.vsix`（`package:vsix` 脚本已带 `--out`）。

默认**不修改** `package.json` 的 `version`：本机安装用 `--force` 覆盖同版本即可。
仅当用户明确要求发布版本或需要区分版本时才 bump 版本号。

### 3. 安装到本机

```powershell
code --install-extension .\pi-code-agent-chat.vsix --force
```

要点：
- `--force` 必需，否则同版本号不会覆盖已安装的扩展。
- 输出中出现 `was successfully installed` 才算成功；`url.parse()` 的
  DeprecationWarning 属于 VS Code CLI 自身噪音，可忽略。
- 若本机可能装有多个宿主（VS Code Insiders / Cursor / Windsurf），先确认目标：
  ```powershell
  Get-Command code, code-insiders, cursor -ErrorAction SilentlyContinue | Select-Object Name, Source
  ```
  存在多个时询问用户装到哪一个，不要自行猜测；单一宿主时直接用 `code`。
- 若扩展正在运行且文件被占用导致安装失败，提示用户关闭所有 VS Code 窗口后重试。

### 4. 校验安装结果（可选但推荐）

```powershell
code --list-extensions --show-versions | Select-String 'pi-code-agent-chat'
```

## 完成后

向用户汇报：验证结果、vsix 路径与体积、安装的扩展 id@version，
并提醒**需要执行 `Developer: Reload Window` 或重启 VS Code 才会生效**。
