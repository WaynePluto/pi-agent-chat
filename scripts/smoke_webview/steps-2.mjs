/* 脚本化会话的中段：展开卡片、子代理 lane、会话页、扩展表面与 lane
   往返。步骤按序执行，且建立在前面的步骤留下的 DOM 之上。 */

import { baseState, RESOURCE_SECTIONS } from "./fixtures.mjs";

export const STEPS_2 = [
  {
    label: "expanded cards: work block, tool card, resources",
    // 不另开快照小节也能覆盖目录引用分支。宿主返回归一化路径；
    // 选择器与 chip 都用尾随斜杠显出目录类型。
    beforeMessages: async (window) => {
      const input = window.document.getElementById("input");
      input.value = "@src";
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 100));
    },
    messages: [{
      type: "projectFiles",
      requestId: 1,
      items: [
        { path: "src", kind: "directory" },
        { path: "src/index.ts", kind: "file" },
      ],
    }],
    // 卡片 body 懒渲染，展开是快照覆盖工具 args/输出、diff 渲染与
    // 思考卡片 body 的唯一途径。资源面板本身要点开 header 按钮才
    // 进入布局。
    beforeSnapshot: (window) => {
      const names = [...window.document.querySelectorAll(".autocomplete-name")].map((node) => node.textContent);
      if (names[0] !== "src/") throw new Error(`directory picker label must end in /, got ${JSON.stringify(names)}`);
      const input = window.document.getElementById("input");
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter" }));
      const chip = window.document.querySelector(".file-ref-label");
      if (chip?.textContent !== "@src/") throw new Error(`directory chip must end in /, got ${chip?.textContent}`);
      window.document.querySelector(".file-ref-remove")?.click();
      // 隐藏的补全行被生产代码有意保留；清掉这点测试残留，
      // 让后续无关快照保持聚焦。
      window.document.getElementById("autocomplete").replaceChildren();

      window.document.getElementById("btn-resources").click();
      for (const selector of [".work-header", ".resources-toggle", ".resource-header", ".card-header"]) {
        for (const header of window.document.querySelectorAll(selector)) header.click();
      }
      // 嵌套块要等父 body 渲染后才存在，需要第二轮：工具的
      // `details` 树在工具卡片里面。
      for (const header of window.document.querySelectorAll(".tool-details-block > .card-header")) header.click();
      // 资源更新与技能高亮都会重建这个面板；展开的 section 必须在
      // 重建后存活而不是弹回折叠。
      window.dispatchEvent(new window.MessageEvent("message", { data: { type: "resources", sections: RESOURCE_SECTIONS } }));
    },
  },
  {
    label: "resources panel toggled back off from the header",
    messages: [],
    beforeSnapshot: (window) => window.document.getElementById("btn-resources").click(),
  },
  {
    label: "subagent: card on the parent",
    messages: [
      {
        type: "state",
        state: {
          ...baseState,
          isStreaming: true,
          delegation: {
            role: "parent",
            running: true,
            lanes: [
              {
                id: "run-1-lane-1",
                title: "auth",
                scope: ["src/auth"],
                status: "running",
                progress: "editing src/auth/login.ts",
                writtenFiles: ["src/auth/session.ts"],
              },
              {
                id: "run-1-lane-2",
                title: "api",
                scope: ["src/api"],
                status: "completed",
                writtenFiles: ["src/api/client.ts"],
                sessionFile: "/workspace/lane-2.jsonl",
                durationMs: 31000,
              },
            ],
          },
        },
      },
      {
        type: "event",
        event: {
          kind: "tool_start",
          id: "call-subagent",
          name: "subagent",
          args: { tasks: [{ task: "make login async", scope: ["src/auth"] }] },
        },
      },
      {
        type: "event",
        event: {
          kind: "tool_end",
          id: "call-subagent",
          name: "subagent",
          text: "Subagents: 1/2 completed.",
          details: {
            lanes: [
              {
                id: "run-1-lane-1",
                title: "auth",
                scope: ["src/auth"],
                status: "failed",
                summary: "could not find the fixture loader",
                writtenFiles: ["src/auth/session.ts"],
                scopeViolations: 1,
                deniedPaths: ["src/api/client.ts"],
                bashMayHaveWritten: true,
              },
              {
                id: "run-1-lane-2",
                title: "api",
                scope: ["src/api"],
                status: "completed",
                summary: "added retry to the client",
                writtenFiles: ["src/api/client.ts"],
                sessionFile: "/workspace/lane-2.jsonl",
              },
            ],
          },
        },
      },
    ],
  },
  {
    label: "subagent: one lane displayed",
    messages: [
      {
        type: "state",
        state: {
          ...baseState,
          isStreaming: true,
          inputDisabled: true,
          delegation: {
            role: "child",
            running: true,
            currentLaneId: "run-1-lane-1",
            parentHasNewActivity: true,
            lanes: [
              {
                id: "run-1-lane-1",
                title: "auth",
                scope: ["src/auth"],
                status: "running",
                writtenFiles: [],
              },
            ],
          },
        },
      },
    ],
  },
  {
    label: "sessions page",
    // 列表到达前页面必须先打开：`renderSessions` 隐藏时跳过渲染，
    // 与真实 UI 行为一致。
    beforeMessages: (window) => window.document.getElementById("btn-sessions").click(),
    messages: [
      { type: "state", state: baseState },
      {
        type: "sessions",
        items: [
          { file: "/workspace/a.jsonl", title: "current session", timestamp: "2026-01-02T03:04:05.000Z", current: true },
          { file: "/workspace/b.jsonl", title: "visible elsewhere", timestamp: "2026-01-01T00:00:00.000Z", current: false, claimedElsewhere: "visible" },
          { file: "/workspace/d.jsonl", title: "background run", timestamp: "2026-01-01T01:00:00.000Z", current: false, claimedElsewhere: "background" },
          {
            file: "/workspace/c.jsonl",
            title: "delegated child",
            timestamp: "2026-01-03T00:00:00.000Z",
            current: false,
            delegationRole: "child",
          },
          // 父级转后台的任务线：两个事实对这几行同时成立，角色是
          // 信息量更大的徽章。点击仍由 claim 决定（它路由到持有它的
          // controller），标出角色没有代价。
          {
            file: "/workspace/e.jsonl",
            title: "waiting parent, elsewhere",
            timestamp: "2026-01-03T01:00:00.000Z",
            current: false,
            delegationRole: "parent",
            claimedElsewhere: "background",
          },
          {
            file: "/workspace/f.jsonl",
            title: "running child, elsewhere",
            timestamp: "2026-01-03T02:00:00.000Z",
            current: false,
            delegationRole: "child",
            claimedElsewhere: "background",
          },
        ],
      },
    ],
    beforeSnapshot: (window) => {
      const sessions = window.document.getElementById("sessions");
      const chat = window.document.getElementById("chat-column");
      const sessionsButton = window.document.getElementById("btn-sessions");
      const treeButton = window.document.getElementById("btn-tree");
      const searchButton = window.document.getElementById("btn-search");
      if (sessionsButton.disabled || treeButton.disabled || searchButton.disabled) {
        throw new Error("an existing session must keep sessions, tree and transcript search available on the sessions page");
      }

      sessionsButton.click();
      if (!sessions.classList.contains("hidden") || chat.classList.contains("hidden")) {
        throw new Error("the narrow sessions button must toggle back to the transcript");
      }
      sessionsButton.click();
      treeButton.click();
      if (!sessions.classList.contains("hidden") || chat.classList.contains("hidden")) {
        throw new Error("session tree must leave the narrow sessions page");
      }
      sessionsButton.click();
      searchButton.click();
      if (!sessions.classList.contains("hidden") || window.document.getElementById("search-bar").classList.contains("hidden")) {
        throw new Error("transcript search must leave the narrow sessions page and open over the transcript");
      }
      searchButton.click();
      sessionsButton.click();

      const visible = window.document.querySelector(".session-row.claimed-visible .session-main");
      if (!visible || visible.disabled) throw new Error("a session visible on another surface must be movable here");
      const background = window.document.querySelector(".session-row.claimed-background .session-main");
      if (!background || background.disabled) throw new Error("a background run must remain recoverable");
      // 后台父级的 lane 仍要读得出是子代理，点击要寻址持有它的
      // controller 而不是开出第二个 writer。
      const foreignLane = window.document.querySelector(".session-row.claimed-background.delegation-child");
      const foreignLaneBadge = foreignLane?.querySelector(".session-badge");
      if (!foreignLaneBadge?.classList.contains("subagent")) {
        throw new Error("a running lane owned by another controller must keep the subagent badge");
      }
      // 这次点击记录在快照的 "posted to host" 段：它必须寻址持有它的
      // controller（`revealSession`）而不是 resume 文件——那会为它开出
      // 第二个 writer。
      foreignLane.querySelector(".session-main").click();
      window.document.getElementById("btn-sessions").click();
    },
  },
  {
    label: "auth gate",
    messages: [{ type: "state", state: { ...baseState, needsAuth: true } }],
    beforeSnapshot: (window) => window.document.getElementById("btn-sessions").click(),
  },
  // 放最后：它需要的 resources 消息会替换前面步骤断言用的更丰富面板。
  {
    label: "explicit /skill: invocation is badged on the user bubble",
    messages: [
      {
        type: "resources",
        sections: [
          {
            name: "Skills",
            items: [
              { label: "update-dependencies", path: "/workspace/.agents/skills/update-dependencies/SKILL.md", scope: "project" },
            ],
          },
        ],
      },
      {
        type: "history",
        events: [
          { kind: "user_message", text: "/skill:update-dependencies", skill: "update-dependencies" },
          { kind: "assistant_message", text: "Checking versions." },
        ],
      },
      { type: "state", state: baseState },
    ],
  },
  // 同样放最后，同一个原因：它会再换一次面板。
  {
    label: "prompt template and extension invocations light up their resource rows",
    messages: [
      { type: "resources", sections: RESOURCE_SECTIONS },
      {
        type: "history",
        events: [
          // 会话存储前已展开，气泡显示正文的同时面板仍给
          // `/review` 记账。
          { kind: "user_message", text: "Review the diff for regressions.", prompt: "review" },
          // 扩展命令执行时根本不会到模型那里。
          { kind: "user_message", text: "/ext-command", extension: "/workspace/.pi/extensions/ext.ts" },
          // 工具调用经两行共享的 path 给注册它的扩展记账。
          { kind: "tool_end", id: "call-2", name: "notify", isError: false, text: "sent", args: { message: "done" } },
          { kind: "assistant_message", text: "Nothing to flag." },
        ],
      },
      { type: "state", state: baseState },
    ],
    // 只把面板重新切回布局：它的展开状态（及各 section 的）延续自
    // 前面的步骤。
    beforeSnapshot: (window) => window.document.getElementById("btn-resources").click(),
  },
  // 高亮的另一半：transcript 里看不到的（随请求发出的上下文文件、
  // 只注册事件钩子的扩展）由宿主自己标行。新的空 history 先清掉
  // 上一步由 transcript 推导的标记。
  {
    label: "host-marked rows: context sent, event-only extension ran",
    messages: [
      { type: "history", events: [] },
      {
        type: "resources",
        sections: RESOURCE_SECTIONS.map((section) => ({
          ...section,
          items: section.items.map((item) =>
            section.name === "Context" || item.path === "/workspace/.pi/extensions/ext.ts" ? { ...item, used: true } : item,
          ),
        })),
      },
      { type: "state", state: baseState },
    ],
  },
  {
    label: "extension surfaces: setStatus row and setWidget blocks above and below the composer",
    messages: [
      { type: "history", events: [] },
      { type: "state", state: baseState },
      {
        type: "extensionStatus",
        items: [
          { key: "services", text: "\u25b6 2 running" },
          { key: "branch", text: "main" },
        ],
      },
      {
        type: "extensionWidgets",
        items: [
          { key: "services", lines: ["dev  :5173  pid 1234", "api  :3000  pid 5678"], placement: "aboveEditor" },
          { key: "hint", lines: ["press /services for details"], placement: "belowEditor" },
        ],
      },
    ],
  },
  {
    label: "extension widget collapsed by the user keeps its line count",
    messages: [],
    beforeSnapshot: (window) => window.document.querySelector("#widgets-above .widget-header").click(),
  },
  {
    label: "extension surfaces cleared when the extension clears its keys",
    messages: [
      { type: "extensionStatus", items: [] },
      { type: "extensionWidgets", items: [] },
    ],
  },
  // 活会话已不在（运行后窗口重载过）的子代理从会话文件回放。它仍要
  // 读得出是那个子代理，而不是一个提供「返回运行中会话」的普通 preview。
  {
    label: "replayed subagent: keeps the subagent banner, not the preview one",
    messages: [
      {
        type: "history",
        transcriptId: "/workspace/lane-b.jsonl",
        events: [{ kind: "user_message", text: "check the python version" }],
      },
      {
        type: "state",
        state: {
          ...baseState,
          inputDisabled: true,
          preview: { file: "/workspace/lane-b.jsonl", title: "check the python version" },
          delegation: {
            role: "child",
            currentLaneId: "replayed",
            running: false,
            lanes: [{ id: "replayed", title: "Python version", scope: [], status: "completed", writtenFiles: [] }],
          },
        },
      },
    ],
  },
  // 走进子代理再回来会从头重建父 transcript。用户打开过的执行过程
  // 必须回来时仍打开：静默重新折叠等于每看一眼 lane 就丢一次位置。
  {
    label: "return from a subagent: expanded work block and reading position kept",
    messages: [
      // 回到父级，上一步的 preview 状态不渗进这个快照。
      { type: "state", state: baseState },
      {
        type: "history",
        transcriptId: "parent-session",
        events: [
          { kind: "user_message", text: "check both versions" },
          { kind: "thinking_message", text: "Delegating." },
          { kind: "assistant_message", text: "Done." },
        ],
      },
    ],
    beforeSnapshot: (window) => {
      window.document.querySelector(".work-header")?.click();
      // 切到子代理的 transcript 再回来。往返才是重点：只记当前
      // transcript 会在这里丢掉展开状态。
      const replay = (transcriptId, events) =>
        window.dispatchEvent(new window.MessageEvent("message", { data: { type: "history", transcriptId, events } }));
      replay("/workspace/lane-a.jsonl", [{ kind: "user_message", text: "check the node version" }]);
      replay("parent-session", [
        { kind: "user_message", text: "check both versions" },
        { kind: "thinking_message", text: "Delegating." },
        { kind: "assistant_message", text: "Done." },
      ]);
      // 阅读位置与展开一并记忆，消息列表与执行过程自己的滚动条都有份。
      // 在此断言而不进 DOM 快照：快照不记滚动偏移。
      const messages = window.document.getElementById("messages");
      const workBody = window.document.querySelector(".work-body");
      messages.scrollTop = 120;
      if (workBody) workBody.scrollTop = 40;
      replay("/workspace/lane-a.jsonl", [{ kind: "user_message", text: "check the node version" }]);
      replay("parent-session", [
        { kind: "user_message", text: "check both versions" },
        { kind: "thinking_message", text: "Delegating." },
        { kind: "assistant_message", text: "Done." },
      ]);
      const restoredWork = window.document.querySelector(".work-body");
      const problems = [];
      if (messages.scrollTop !== 120) problems.push(`message list at ${messages.scrollTop}, expected 120`);
      if (restoredWork && restoredWork.scrollTop !== 40) problems.push(`work block at ${restoredWork.scrollTop}, expected 40`);
      if (problems.length > 0) throw new Error(`scroll position not restored: ${problems.join("; ")}`);
    },
  },
];
