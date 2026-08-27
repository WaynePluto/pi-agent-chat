---
name: write-changelog
description: 按本项目标准编写发版 changelog：docs/changelog/<版本>.md（英文）与 .zh-CN.md（简体中文）两份，并在根 CHANGELOG.md 索引补链接。风格为逐条事实清单（新增/变更/修复/移除/升级/内部），不写设计理由与解释性文字。当用户要求写 changelog、更新版本说明、准备发版/release 时使用。
---

# write-changelog

本项目的 changelog 是**给用户看的变更事实清单**，不是设计文档。0.0.15 确立的标准：
一句话说清「什么变了」，不解释为什么。

## 文件与时机

- 每个版本两份：`docs/changelog/<版本>.md`（英文，GitHub Release 说明的正式来源）与
  `docs/changelog/<版本>.zh-CN.md`（简体中文，内容忠实对应、章节一致）。
- 标题统一 `# Pi Agent Chat <版本>`。
- **发布 tag 前必须写好**：release workflow（`.github/workflows/release.yml`）直接读英文文件
  当 Release 说明，文件不存在直接失败。workflow 会在说明末尾自动追加 Full Changelog 与中文版
  链接，文件里不要自己写这两个链接。
- 根 `CHANGELOG.md` 是纯索引：顶部插一行，链接用绝对 GitHub URL（`docs/` 不进 VSIX，相对路径
  在 Marketplace 里会断）：

  ```text
  - [<版本>](https://github.com/WaynePluto/pi-agent-chat/blob/v<版本>/docs/changelog/<版本>.md) / [简体中文](https://github.com/WaynePluto/pi-agent-chat/blob/v<版本>/docs/changelog/<版本>.zh-CN.md)
  ```

- 通常与版本号修改、打 tag 放同一个发布提交；流程细节见 `docs/releasing.md`。

## 章节与顺序

按用户感知程度排序，没有内容的章节整个省掉：

1. `## Added`（新增）—— 用户可用的能力、命令、配置项；设置名用反引号，附默认值/上下限等硬事实。
2. `## Changed`（变更）—— 已有能力的行为或外观变化，含配置项语义变化。
3. `## Fixed`（修复）—— 用户可能撞到的 bug；写「现在怎样了」，不写踩坑史。
4. `## Removed`（移除）—— 没了的东西：功能、文件、配置键、UI 元素。用户可能依赖它们，必须单列。
5. `## Dependencies`（升级）—— 每行一个 `包名: 旧 → 新`；Pi SDK 两个包合一行。本节存在时，
   顺手确认 update-dependencies 技能第 4 步的文案同步（README / package.nls /
   THIRD-PARTY-NOTICES.txt）已经做过。
6. `## Internal`（内部）—— 只影响开发者的：构建、自检、冒烟测试、快照基线。

## 写法标准

**一条 = 一个事实，尽量一行。** 英文文件按约 90 列折行；中文一条一行、不折行。

- 只写「什么变了」，删掉一切「为什么、为了什么、按什么原则」。设计理由属于 commit message
  与 AGENTS.md，不属于 changelog。
- 判据：读者只需要知道「有什么不一样、我要不要做什么」；「当时为什么这么改」对他没有行动
  价值，删。
- 合并同源提交：git log 里五个 commit 讲同一件事，changelog 里就是一条。
- 排版平淡：默认不加粗、不用表情与形容词（「更好的」「优雅的」）；强调靠章节与位置，不靠
  墨水。专有名词与项目用语对齐 README / AGENTS.md（rail、surface、transcript、controller…），
  设置名、包名、键名一律反引号。
- 硬数字是事实不是解释，保留（默认值、上限、阈值、迁移键名）。

**不写进 changelog 的**：设计哲学与权衡、被否掉的备选方案、验证与排查过程、bug 的历史沿革、
未来计划、对旧版本的感慨。

## 步骤

1. 定版本：读 `package.json` 的 `version`（应与将要打的 tag 一致）。
2. 收集变更：`git log v<上一版本>..HEAD --oneline` 与 `git diff v<上一版本>..HEAD --stat`，
   逐条归入上面的章节；同一主题多提交合并成一条。
3. 对照自查：用户可见的变更每条都有归属吗？有没有解释性从句（因为/以便/这样一来/原因是…）？
   中英两份章节与条目一一对应吗？根索引补了吗？
4. 写两份文件 + 根 `CHANGELOG.md` 索引补行。
5. 汇报：写了哪些文件、变更面概览，并提醒 tag 必须等 changelog 就位后再推。

## 反例（0.0.15 定稿前的真实教训）

- ❌ "A full visual pass, guided by one rule: visual weight follows what needs your attention."
  —— 设计哲学，删。
- ❌ "…because at 380px that is exactly where the failures used to disappear." —— 排查故事，删。
- ❌ 一条五层子弹、连讲三段的条目 —— 拆成多条一行事实，或压成一条。
- ✅ "Manual retry button is no longer lost when a request settles on a timeout error."
  —— 事实、一行、可行动。
