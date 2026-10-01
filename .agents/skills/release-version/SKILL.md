---
name: release-version
description: 执行 pi-agent-chat 的版本发布流程。预发布版本号 = 下一个正式版本 + 当日日期（如最新正式 tag 是 v0.0.20 时，预发布为 0.0.21-20261001）；每次发布都先把之前所有预发布连根清理（GitHub Release、远程/本地 tag），旧预发布的 changelog 改名前进并入最新文档。正式发布 = 当前预发布去掉日期后缀。推 v* tag 触发 release.yml 构建三平台 VSIX 并建 GitHub Release；Marketplace 上传是正式发布后的手动步骤。当用户要求发布预发布/正式版本、打发布 tag 或清理旧预发布时使用。不适用于单纯写 changelog（write-changelog 技能）或依赖升级（update-dependencies 技能）。
---

# 版本发布（预发布 / 正式）

## 版本号规则

- **预发布**：`<下一个正式版本>-<YYYYMMDD>`，日期取当天。下一个正式版本默认 = 最新
  **正式** tag 的 patch + 1（例：正式版最新是 0.0.20，预发布就是 `0.0.21-20261001`）；
  用户点名别的跳版（如 0.1.0）时从其要求。同一天重复发布**复用同一版本号**：
  修正提交后强制更新 tag 重打。
- **正式**：当前预发布去掉日期后缀（`0.0.21-20261001` → `0.0.21`）。
- tag 名为 `v<版本号>`，必须与根 `package.json` 的 `version` 完全一致，release workflow
  有硬校验。版本号含 `-` 时 GitHub Release 自动标记为预发布。
- 判定「预发布 tag」：tag 名匹配 `v<数字>.<数字>.<数字>-*`。**正式 tag 永远不参与清理。**

## 核心不变量：任何时刻至多存在一个预发布

历史预发布不累积。每次发布（无论预发布还是正式）都先清理之前所有预发布的
GitHub Release 与远程/本地 tag；changelog 文件随新文档**改名前进**而不是保留独立
文件（`git mv` 让 git 记成 rename，历史可追溯），更新说明内容并入最新版本。

## 步骤一：清理历史预发布（两种发布都先做）

1. 列出本地与远程的预发布 tag，**向用户展示**后再删：

   ```bash
   git tag -l "v[0-9]*.[0-9]*.[0-9]*-*"
   git ls-remote --tags origin | grep -E "refs/tags/v[0-9]+\.[0-9]+\.[0-9]+-"
   ```

2. 对每个旧预发布 tag，按顺序清理（先 Release 后 tag，避免留下指向悬空 tag 的 Release）：

   ```bash
   gh release view <tag>                          # 存在才删；gh 未登录先让用户 gh auth login
   gh release delete <tag> --yes --cleanup-tag    # 顺带删远程 tag
   git push origin --delete <tag>                 # 上一步没删掉远程 tag 时补刀
   git tag -d <tag>                               # 本地 tag
   ```

3. `docs/changelog/` 里旧预发布版本号命名的文件**不在这一步删**：最新的那份由步骤三
   rename 前进；只有更早的中间预发布残留文件（流程被打断时才会出现）才在内容并入
   最新文档后删除，`CHANGELOG.md` 索引行同步。

## 步骤二：写入新版本号并校验

版本号只出现在**根 `package.json` 的 `version` 一个位置**（无 workspace 包、无运行时
版本常量）。纯版本变更**不动 `pnpm-lock.yaml`**（lockfile 不记录本项目版本；历史上
正式发布提交就是 4 个文件）。发布提交若顺带未提交的功能或依赖改动，按 AGENTS.md
常规处理（依赖变了才 `pnpm install` 刷 lockfile）。

打 tag 前跑与 release workflow 相同的校验并全部通过：

```bash
pnpm typecheck
pnpm verify
```

## 步骤三：changelog

写法、章节与排版标准全部见 **write-changelog 技能**，这里只说版本发布特有的部分：

- **预发布**：把旧预发布的两份文档（若在）`git mv` 为新版本名
  `docs/changelog/<新版本>.md` 与 `.zh-CN.md`，旧内容并入（同主题合并，不逐版罗列）
  再追加本轮变化；标题行改为 `# Pi Agent Chat <新版本>`。首次预发布（无旧文档）
  则新建两份。
- **正式**：把当前预发布的两份文档 `git mv` 为正式版本名，标题行同步；内容去掉
  「预发布迭代」类措辞，作为该正式版本的完整说明。
- `CHANGELOG.md` 索引同步：预发布条目只保留最新一个（替换旧行）；正式条目按版本
  倒序。行格式用绝对 GitHub URL（`docs/` 不进 VSIX，Marketplace 里相对路径会断）。

## 步骤四：提交、打 tag、推送

```bash
git status                       # 确认变更集合（至少：package.json + 两份 changelog + 索引行）
git add -A
git commit -m "chore: 发布 <版本>"
git push origin master
git tag v<版本>
git push origin v<版本>
```

**同一天重发同一版本**：复用版本号，修正内容后提交（或在预发布提交上 amend 并同步
分支），然后 `git tag -f v<版本>` + `git push --force origin v<版本>`；release.yml 对
同版本重打 tag 会先删旧 Release 再重建，无需手动清理。

推 `v*.*.*` tag 后 release workflow 在三个 runner 各构建一个目标 VSIX（`win32-x64` /
`linux-x64` / `darwin-arm64`）并创建 GitHub Release——说明取 `docs/changelog/<版本>.md`，
末尾自动追加 Full Changelog 与中文版链接，**文件里不要自己写这两个链接**：

```bash
gh run watch                     # 跟踪三路构建
gh release view v<版本>          # 确认 Release 与 3 个 VSIX 附件齐全
```

## 正式发布后：Marketplace 上传（手动）

GitHub Release 只是一条分发渠道。正式发布后按 `docs/releasing.md` 在浏览器里把三平台
VSIX 手动上传到 publisher `waynepluto`（同一扩展版本、三个 target 全传；不上传无平台
限定符的本地产物）。预发布不上 Marketplace。

## 红线

- 正式 tag 不可删；清理只针对带 `-` 后缀的预发布 tag。
- 远程清理顺序：先 GitHub Release 再远程 tag。
- tag 必须与 `package.json` 的 `version` 完全一致，且打 tag 前
  `docs/changelog/<版本>.md` 必须已就位——release workflow 两项都硬校验，缺了直接失败。
- 不手改 `pnpm-lock.yaml`；纯版本变更不需要动它。
- 不用 `git push --tags`：推全部本地 tag 会把陈旧 tag 带上远程，tag 一律点名推送。
- 删除远程 tag / Release 前先把清单亮给用户（本 skill 的既定策略是用户确认过的批量
  清理，但列出被删对象是必须的动作）。
