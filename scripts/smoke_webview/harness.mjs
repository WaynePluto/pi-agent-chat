import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { JSDOM } from "jsdom";
import { RESOURCE_SECTIONS } from "./fixtures.mjs";
import { SCRIPT } from "./steps.mjs";
import { snapshot, flush } from "./dom.mjs";

/* ------------------------------------------------------------------ */
/* 测试装置                                                           */
/* ------------------------------------------------------------------ */

export async function run({ bundlePath, baselinePath, update }) {
  if (!existsSync(bundlePath)) {
    console.error(`[fail] ${bundlePath} not found - run "pnpm build" first`);
    process.exit(1);
  }

  const dom = new JSDOM(`<!DOCTYPE html><html lang="en"><body class="surface-sidebar"><div id="root"></div></body></html>`, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // jsdom 没有布局，但保留回调让特征测试能驱动基于事件的宽/窄模式
  // 切换并断言可见性/状态。
  let resizeCallback;
  window.ResizeObserver = class {
    constructor(callback) {
      resizeCallback = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // jsdom `pretendToBeVisual` 的 requestAnimationFrame 按定时器触发，相对
  // 本测试 5ms flush 的时延随 Node 补丁版本漂移（22.22 与 22.23 的差别
  // 足以翻转「流式重渲染是否赶在快照前」）。把动画帧回调改为微任务，
  // 保证各 Node 版本渲染出的 DOM 一致；`scheduleRender` 在同步突发内的
  // 批处理不受影响——微任务在当前脚本之后、flush 超时之前排干。
  let rafId = 0;
  window.requestAnimationFrame = (callback) => {
    const id = ++rafId;
    queueMicrotask(() => callback(Date.now()));
    return id;
  };
  window.cancelAnimationFrame = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const posted = [];
  // api 的持久化状态半边，按 VS Code 提供的样子：一个能在 webview
  // 重载后存活的黑盒对象。挂在 window 上供测试检查，但不预置——
  // 冒烟从全新 webview 开始。
  window.__persistedState = null;
  window.acquireVsCodeApi = () => ({
    postMessage: (message) => posted.push(message),
    getState: () => window.__persistedState,
    setState: (state) => {
      window.__persistedState = state;
    },
  });

  window.eval(readFileSync(bundlePath, "utf8"));

  const sections = [];
  for (const [index, step] of SCRIPT.entries()) {
    await step.beforeMessages?.(window);
    for (const message of step.messages) {
      // 宿主总是标明正在回放的 transcript；webview 以它为键存各
      // transcript 的视图状态（展开的块）。默认每步一个、场景彼此隔离；
      // 要验证「状态在重建后存活」时再让步骤显式共享同一 id。
      const data =
        message.type === "history" && message.transcriptId === undefined
          ? { ...message, transcriptId: `step-${index}` }
          : message;
      window.dispatchEvent(new window.MessageEvent("message", { data }));
    }
    await step.beforeSnapshot?.(window);
    await flush(window);
    sections.push(`===== ${step.label} =====\n${snapshot(window)}`);
  }

  const rootEl = window.document.getElementById("root");
  const sessionsEl = window.document.getElementById("sessions");
  const resourcesEl = window.document.getElementById("resources");
  const chatColumnEl = window.document.getElementById("chat-column");
  const resourcesPanel = () => window.document.querySelector(".resources-panel");
  const sessionsBtn = window.document.getElementById("btn-sessions");
  const resourcesBtn = window.document.getElementById("btn-resources");
  // 把窄屏面板置成与宽屏栏默认值不同的状态，下方的断言才能区分
  // 「各模式各管各的」与「继承了另一模式的状态」。
  if (resourcesEl.classList.contains("hidden")) resourcesBtn.click();
  if (!resourcesPanel()?.classList.contains("collapsed")) {
    window.document.querySelector(".resources-toggle")?.click();
  }
  const narrowResourcesShown = !resourcesEl.classList.contains("hidden");
  const narrowResourcesCollapsed = resourcesPanel()?.classList.contains("collapsed");
  if (!narrowResourcesShown || !narrowResourcesCollapsed) {
    throw new Error("the narrow resources panel must be shown and collapsed before the width sweep");
  }

  resizeCallback?.([{ contentRect: { width: 1600 } }]);
  await flush(window);
  if (!rootEl.classList.contains("layout-wide")) throw new Error("1600px must enter wide layout");
  if (chatColumnEl.classList.contains("hidden")) {
    throw new Error("wide layout must keep the chat column");
  }
  // 到达阈值不开任何东西，只让侧栏「成为可能」：窗口 resize 不得背着
  // 用户重排界面，侧栏轨道在被要求前保持收起。
  if (!sessionsEl.classList.contains("hidden")) {
    throw new Error("entering wide layout must not open the sessions rail on its own");
  }
  if (!resourcesEl.classList.contains("hidden")) {
    throw new Error("entering wide layout must not open the resources rail on its own");
  }
  if (rootEl.style.getPropertyValue("--rail-sessions") !== "0px" || rootEl.style.getPropertyValue("--split-sessions") !== "0px") {
    throw new Error("a closed rail must collapse both its own track and its divider");
  }
  sessionsBtn.click();
  if (sessionsEl.classList.contains("hidden") || chatColumnEl.classList.contains("hidden")) {
    throw new Error("the wide sessions button must open only the left rail");
  }
  if (rootEl.style.getPropertyValue("--rail-sessions") === "0px") {
    throw new Error("an open rail must give its grid track a width");
  }
  resourcesBtn.click();
  if (resourcesEl.classList.contains("hidden")) {
    throw new Error("the wide resources button must open the rail");
  }
  // 宽屏栏与窄屏面板是两个独立表面、各持状态：用户开的栏一律展开，
  // 不管窄屏面板当时如何。
  if (resourcesPanel()?.classList.contains("collapsed")) {
    throw new Error("the wide resources rail must open expanded");
  }
  sections.push(`===== wide layout: draggable rails, nothing auto-opened =====\n${snapshot(window)}`);

  // 上面渲染过的 section 都被手动开过，这类决定属于用户且两模式共享；
  // 要验证各模式默认值就得用一个从未碰过的 section。探针 payload 在
  // 快照之后派发：它会替换面板内容（含高亮），只有下方断言读的折叠
  // 状态能在重建后存活。
  const showResources = async (payload) => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "resources", sections: payload } }));
    await flush(window);
  };
  const probeSections = [{ name: "Probe", items: [{ label: "probe", scope: "builtin" }] }];
  const probeSection = () => window.document.querySelector(".resource-section");
  await showResources(probeSections);
  // 开栏是为了读；只显示 section 标题会浪费用户刚给它的整列空间。
  if (probeSection()?.classList.contains("collapsed")) {
    throw new Error("an untouched section must default to expanded in the wide rail");
  }

  resizeCallback?.([{ contentRect: { width: 1000 } }]);
  await flush(window);
  if (rootEl.classList.contains("layout-wide") || !sessionsEl.classList.contains("hidden")) {
    throw new Error("1000px must restore narrow layout with the sessions page closed");
  }
  if (resourcesEl.classList.contains("hidden") === narrowResourcesShown) {
    throw new Error("the narrow panel must keep its own visibility, not the rail's");
  }
  if (resourcesPanel()?.classList.contains("collapsed") !== narrowResourcesCollapsed) {
    throw new Error("the narrow panel must keep its own expansion, not the rail's");
  }
  // 在另一侧做同样探针：窄屏浮层压在 transcript 上，故逐层打开。
  await showResources(probeSections);
  if (!probeSection()?.classList.contains("collapsed")) {
    throw new Error("an untouched section must default to collapsed in the narrow panel");
  }
  await showResources(RESOURCE_SECTIONS);
  resizeCallback?.([{ contentRect: { width: 1600 } }]);
  await flush(window);
  // 恢复不等于自动打开：上面用户开过的栏要回来——每次 resize 都丢掉
  // 刻意选择本身就是 bug。
  if (resourcesEl.classList.contains("hidden") || sessionsEl.classList.contains("hidden")) {
    throw new Error("the wide rails must come back as the user left them");
  }
  resizeCallback?.([{ contentRect: { width: 1000 } }]);
  await flush(window);

  const actual = `${sections.join("\n\n")}\n\n===== posted to host =====\n${posted
    .map((message) => JSON.stringify(message))
    .join("\n")}\n`;

  window.close();

  if (update || !existsSync(baselinePath)) {
    writeFileSync(baselinePath, actual);
    console.log(`[ok]   webview snapshot written: ${baselinePath}`);
    return;
  }

  const expected = readFileSync(baselinePath, "utf8").replace(/\r\n/g, "\n");
  // 归一 CRLF：core.autocrlf=true 的 Windows 检出上比对才稳定（快照文件
  // 已由 .gitattributes 钉为 LF，这里防的是没有该规则的本地克隆）。
  if (expected === actual) {
    console.log(`[ok]   webview snapshot matches (${SCRIPT.length} steps, ${posted.length} host messages)`);
    return;
  }

  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  console.error("[fail] webview snapshot changed:");
  for (let i = 0; i < Math.max(expectedLines.length, actualLines.length); i += 1) {
    if (expectedLines[i] === actualLines[i]) continue;
    console.error(`  line ${i + 1}\n    - ${expectedLines[i] ?? "(missing)"}\n    + ${actualLines[i] ?? "(missing)"}`);
  }
  console.error('  If the change is intended, re-run with "--update" and review the diff in git.');
  process.exit(1);
}
