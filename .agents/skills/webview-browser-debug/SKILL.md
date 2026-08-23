---
name: webview-browser-debug
description: 在真实 Chrome（CDP + playwright-core）中加载并驱动本插件构建产物 dist/webview.js，复现与验证 jsdom 冒烟测试覆盖不了的交互行为：滚动与滚轮、自动贴底、布局高度、焦点与键盘。当 webview 出现滚动异常、贴底/跟随类 bug、焦点劫持、键盘交互问题，或任何依赖真实布局与真实输入事件的前端行为需要验证时使用。不适用于宿主侧（extension/bridge/runtime）逻辑，那类问题走 diagnostics 自检。
---

# Webview 浏览器实测

`scripts/smoke_webview.mjs`（jsdom）没有布局、没有滚动、没有滚轮——凡是对「滚动位置、几何、输入事件」敏感的 webview bug，快照绿色只说明 DOM 没变，说明不了行为正确。此时把构建产物放进真实 Chrome，用 CDP 驱动。

## 准备

1. 先 `pnpm build`——测的是 `dist/webview.js`，不重建就是在测旧产物。
2. 浏览器与依赖走 `browser-tools` 技能（已装 playwright-core）：`node <browser-tools>/scripts/browser-start.mjs` 启动 `:9222`，脚本里 `chromium.connectOverCDP("http://127.0.0.1:9222")` 连接。
3. 脚手架放 `scratch/`（不入库），用完删除。

## 驱动页骨架（scratch/repro.html）

真实 bundle 的启动要求，缺一个就白屏或行为失真：

- **`<div id="root">`**：`shell.ts` 往它里面 `innerHTML` 整个骨架，没有它直接抛错。
- **高度链**：`html, body, #root` 必须有确定高度（`#root` 是 `flex-direction: column; height: 100%`）。否则 transcript `clientHeight` 无限、不可滚动（`max=0`），所有滚动断言全部作废。
- **`window.acquireVsCodeApi` stub**：`() => ({ postMessage: m => 收集, getState, setState })`。
- **样式**：`<link rel="stylesheet" href="../media/main.css">` + 手工定义一组 `--vscode-*` 变量（`--vscode-sideBar-background`、`--vscode-editor-background`、`--vscode-foreground` 等），否则布局塌掉。
- **加载**：`<script src="../dist/webview.js"></script>`（stub 必须在它之前）。
- **驱动宿主消息**：`dispatchEvent(new MessageEvent("message", { data: hostMessage }))`。消息形状见 `src/shared/protocol.ts` 与 `scripts/smoke_webview.mjs` 的 fixture：先发 `{ type: "state", state: {...} }`，再发 `{ type: "event", event: { kind: ... } }`。
- **观测**：在 harness 里挂 `scroll` / `wheel` 监听（`{ passive: true }`），带 `performance.now()` 时间戳写进环形日志缓冲，跑完一次性取回——比在驱动脚本里轮询 `__state()` 可靠，能看清事件顺序与因果。

## CDP 驱动要点（scratch/test.mjs）

- **页签卫生**：连接后先按 URL 关掉上次运行留下的复现页签，再 `newPage()`；结束 `page.close()` 后只 `browser.close()` 断连，浏览器存活。页签积多了浏览器会卡死。
- **坐标在动作前一刻取**：流式内容持续增长，提前算好的 `boundingBox()` 中心很快落到错误元素上。发滚轮前用 `elementFromPoint(x, y)` 确认命中目标。
- **`waitForSelector` 默认等 visible**：折叠容器（work block、卡片）里的元素永远不可见会超时，用 `{ state: "attached" }`。
- **展开路径**：work block 与卡片默认折叠，点击 `.work-block .work-header`、再点 `.thinking-card .card-header`。subagent 卡片是唯一默认展开的特例。
- **真实输入**：`page.mouse.wheel(0, deltaY)` / `page.mouse.move` / `locator.click()`。滚轮方向：向上是负值。
- 页面报错务必收集（`page.on("pageerror")`），bundle 启动失败时第一个症状常常只是「没有卡片出现」。

## 已验证的滚动行为事实（结论，别再重新实验）

这些在真实 Chrome + 本项目 DOM 结构上验证过，直接当已知条件用：

- **程序赋值 `scrollTop` 同样触发 `scroll` 事件**：几何位置（距底部多远、是否精确落底）区分不了「用户操作」与「程序贴底/钳制」。
- **`wheel` 事件是程序无法合成的输入**：判定用户滚动意图的唯一可靠信号就是它。
- **嵌套滚动容器（`.card-body` 的 `max-height`）在自身 `scrollTop > 0` 时消费滚轮**，不传给外层 transcript；`scrollTop = 0` 时向上的滚轮继续冒泡给外层。判定「读卡片」还是「逃离底部」就看这个。
- **Chromium 不把一次滚轮的剩余增量链式传给外层**：内层差 10px 到顶、滚了 -40，只消费 10px，外层纹丝不动。
- **`replaceChildren` 全量重建保留 `scrollTop`**：流式期间每帧重渲染不会丢阅读位置。
- **内容收缩会把 `scrollTop` 钳制到新的最大值**，产生一个「精确落底」的 scroll 事件——这不是用户意图，恢复自动跟随的规则绝不能建立在它上面。
- 无头/快照环境里元素高度测出来是 0，折叠与位置判定不可用测量（项目既有约定）。

## 边界

- 测的是 **webview 行为**；宿主侧逻辑用 `diagnostics.ts` 自检项钉（见 AGENTS.md「宿主侧状态必须由宿主侧测试守」）。
- VS Code webview 环境仍可能与裸 Chrome 有差异：真实环境复现不了时，把复现页结论当「必要条件验证」，再回真实插件确认。
