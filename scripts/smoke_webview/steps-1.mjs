/* 脚本化会话的第一段：空会话提示、历史回放、composer 菜单、折叠与
   实时流式。步骤按序执行，且建立在前面的步骤留下的 DOM 之上。 */

import { baseState, PATCH, LONG_PROMPT, TINY_PNG, LONG_ANSWER, RESOURCE_SECTIONS, MODEL_CATALOG } from "./fixtures.mjs";

/** 每个步骤：一个 label，加上快照前投递的 HostMessage。 */
export const STEPS_1 = [
  {
    label: "startup: resources + commands + empty state",
    messages: [
      { type: "history", events: [] },
      { type: "resources", sections: RESOURCE_SECTIONS },
      {
        type: "commands",
        items: [
          { name: "model", description: "Select model", kind: "builtin" },
          { name: "skill:demo", description: "Demo skill", kind: "skill" },
        ],
      },
      { type: "state", state: { ...baseState, messageCount: 0 } },
    ],
  },
  {
    label: "header keeps the six direct text actions",
    messages: [],
    beforeSnapshot: (window) => {
      const ids = [...window.document.querySelectorAll("#header-actions > button:not(#btn-header-more)")]
        .map((button) => button.id);
      const expected = ["btn-new", "btn-sessions", "btn-tree", "btn-search", "btn-resources", "btn-settings"];
      if (ids.join(",") !== expected.join(",")) throw new Error(`unexpected header actions: ${ids.join(",")}`);
      if (window.document.getElementById("peer-session-bar")) throw new Error("peer-session notice must not be rendered");
      window.document.getElementById("header-title")
        .dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
    },
  },
  {
    label: "empty state: overridden system prompt drops the docs hint",
    messages: [{ type: "history", events: [], systemPromptOverridden: true }],
  },
  {
    // 内置 subagent 屏蔽扩展工具是「会话怎么装配」的事实，属于新会话
    // 提示——不能是 transcript 事件：那会顶掉这个占位符并开出
    // 凭空的执行过程块。
    label: "empty state: extension subagent shadowed, subagent off",
    messages: [
      {
        type: "history",
        events: [],
        subagent: { enabled: false, shadowedExtension: "/home/u/.pi/agent/extensions/subagent/index.ts" },
      },
    ],
  },
  {
    // 同一事实换措辞：开关关闭的会话里一个委派工具都没有，
    // 提示不能承诺它。
    label: "empty state: extension subagent shadowed, subagent on",
    messages: [
      {
        type: "history",
        events: [],
        subagent: { enabled: true, shadowedExtension: "/home/u/.pi/agent/extensions/subagent/index.ts" },
      },
    ],
  },
  {
    // 功能默认关闭、无屏蔽扩展时不可见，空会话提示是它唯一的发现入口。
    label: "empty state: subagent off, nothing shadowed",
    messages: [{ type: "history", events: [], subagent: { enabled: false } }],
  },
  {
    // 已开启且无屏蔽：不加段落——用户自己开的，资源面板里也看得见。
    label: "empty state: subagent on, nothing shadowed",
    messages: [{ type: "history", events: [], subagent: { enabled: true } }],
  },
  {
    // 终端工具同样处理，两条提示可同时出现：两个独立工具各说各话，
    // 屏蔽其一、关闭其二的会话两件都得说。
    label: "empty state: extension terminal shadowed, terminal off",
    messages: [
      {
        type: "history",
        events: [],
        terminal: { enabled: false, shadowedExtension: "/home/u/.pi/agent/extensions/vscode-terminal.ts" },
      },
    ],
  },
  {
    label: "empty state: extension terminal shadowed, terminal on",
    messages: [
      {
        type: "history",
        events: [],
        terminal: { enabled: true, shadowedExtension: "/home/u/.pi/agent/extensions/vscode-terminal.ts" },
      },
    ],
  },
  {
    // 两个工具都关且无屏蔽：全新安装的默认状态，也是两个功能
    // 仅有的可发现处。
    label: "empty state: subagent and terminal both off",
    messages: [{ type: "history", events: [], subagent: { enabled: false }, terminal: { enabled: false } }],
  },
  {
    label: "history replay: user + thinking + tool + assistant",
    messages: [
      {
        type: "history",
        events: [
          { kind: "user_message", text: "Fix the bug in **demo.ts**" },
          { kind: "thinking_message", text: "Reading the file first." },
          {
            kind: "tool_end",
            id: "call-1",
            name: "edit",
            isError: false,
            text: "applied",
            args: { path: "src/demo.ts" },
            patch: PATCH,
            path: "/workspace/src/demo.ts",
          },
          { kind: "assistant_message", text: "Done.\n\n- changed `b` to 3\n- nothing else" },
        ],
      },
      { type: "state", state: baseState },
    ],
  },
  {
    label: "model without selectable thinking level hides composer control",
    messages: [{ type: "state", state: { ...baseState, thinkingLevel: "off", thinkingLevels: ["off"] } }],
  },
  {
    label: "composer model menu: frequently used models plus the native picker hand-off",
    messages: [{ type: "state", state: baseState }, { type: "models", catalog: MODEL_CATALOG }],
    beforeSnapshot: (window) => window.document.getElementById("btn-model").click(),
  },
  {
    label: "composer model menu without frequently used models",
    // 再次打开不得复制出第二条「其他模型」行。
    beforeMessages: (window) => window.document.getElementById("btn-model").click(),
    messages: [{ type: "models", catalog: { items: [] } }],
    beforeSnapshot: (window) => window.document.getElementById("btn-model").click(),
  },
  {
    label: "composer thinking menu",
    // 打开第二个菜单必须替换第一个，而不是叠在它上面。
    beforeMessages: (window) => window.document.getElementById("btn-thinking").click(),
    messages: [],
  },
  {
    label: "quick menu closed again",
    beforeMessages: (window) => window.document.getElementById("btn-thinking").click(),
    messages: [],
  },
  {
    label: "per-message tree actions bound to session entries",
    messages: [
      {
        type: "history",
        events: [
          { kind: "user_message", text: "first prompt" },
          { kind: "assistant_message", text: "first answer" },
          { kind: "user_message", text: "second prompt" },
        ],
      },
      { type: "entryIds", ids: ["entry-1", "entry-3"], labels: [undefined, "before refactor"], assistantIds: ["entry-2"], assistantLabels: [undefined] },
      { type: "state", state: baseState },
    ],
    beforeSnapshot: (window) => {
      const problems = [];
      const assistant = [...window.document.querySelectorAll(".bubble.assistant")];
      if (assistant.length !== 1) throw new Error(`expected 1 assistant bubble, got ${assistant.length}`);
      // 回答同样可寻址：同样三个动作，放在它右侧留白。
      if (assistant[0].dataset.entryId !== "entry-2") problems.push(`assistant bubble should get entry-2, got "${assistant[0].dataset.entryId}"`);
      if (assistant[0].querySelectorAll(".bubble-actions > .bubble-action").length !== 3) problems.push("assistant bubble should carry three actions");
      if (problems.length > 0) throw new Error(`entry id binding: ${problems.join("; ")}`);
    },
  },
  // 扩展命令永远进不了会话文件，`bubbleEntryIds` 对它没有条目。按位置
  // 映射 id 时必须跳过扩展命令气泡，否则其后真正的消息错位一格、
  // 丢失动作按钮。
  {
    label: "extension-command bubble skipped when binding entry ids",
    messages: [
      {
        type: "history",
        events: [
          { kind: "user_message", text: "/ext-command", extension: "/workspace/.pi/extensions/ext.ts" },
          { kind: "user_message", text: "real prompt" },
        ],
      },
      { type: "entryIds", ids: ["entry-real"], labels: [undefined], assistantIds: [], assistantLabels: [] },
      { type: "state", state: baseState },
    ],
    beforeSnapshot: (window) => {
      const bubbles = [...window.document.querySelectorAll(".bubble.user")];
      const problems = [];
      if (bubbles.length !== 2) throw new Error(`expected 2 user bubbles, got ${bubbles.length}`);
      if (bubbles[0].dataset.noEntry === undefined) problems.push("extension bubble should have data-no-entry");
      if (bubbles[0].dataset.entryId) problems.push(`extension bubble should not get an entry id, got "${bubbles[0].dataset.entryId}"`);
      if (bubbles[1].dataset.entryId !== "entry-real") problems.push(`real bubble should get entry-real, got "${bubbles[1].dataset.entryId}"`);
      if (problems.length > 0) throw new Error(`entry id binding: ${problems.join("; ")}`);
    },
  },
  // 图片附件：缩略图必须在 `.bubble-content`（折叠裁剪的元素）之外；
  // 纯附件消息尽管显示文本为空也仍要渲染气泡——宿主的
  // `bubbleEntryIds` 数的就是它，这里丢了它后面所有 entry id 都错位。
  {
    label: "user message with image attachments",
    messages: [
      {
        type: "history",
        transcriptId: "image-attachments",
        events: [
          {
            kind: "user_message",
            text: "what is wrong here?",
            images: [{ mimeType: "image/png", data: TINY_PNG, name: "shot.png" }],
          },
          { kind: "assistant_message", text: "The border is 1px off." },
          { kind: "user_message", text: "", images: [{ mimeType: "image/png", data: TINY_PNG }] },
        ],
      },
      { type: "state", state: baseState },
    ],
    beforeSnapshot: (window) => {
      const bubbles = [...window.document.querySelectorAll(".bubble.user")];
      const problems = [];
      if (bubbles.length !== 2) throw new Error(`expected 2 user bubbles, got ${bubbles.length}`);
      for (const [index, bubble] of bubbles.entries()) {
        const strip = bubble.querySelector(".bubble-images");
        if (!strip) problems.push(`bubble ${index} has no image strip`);
        else if (strip.parentElement !== bubble) problems.push(`bubble ${index}: images must not live inside the folding content`);
        if (bubble.querySelector(".bubble-content .bubble-images")) problems.push(`bubble ${index}: image strip is inside .bubble-content`);
      }
      if (problems.length > 0) throw new Error(`image attachments: ${problems.join("; ")}`);
    },
  },
  // 折叠：只有每个角色最新的消息保持展开，且只有长消息才折（折一行
  // 短句多点一次却什么都不省）。长度按 Markdown 源文本判定，正是为了
  // 在这个每个元素测量值都是 0 的环境里可复现。
  {
    label: "long messages fold except the newest of each role",
    messages: [
      {
        type: "history",
        transcriptId: "long-messages",
        events: [
          { kind: "user_message", text: LONG_PROMPT },
          { kind: "assistant_message", text: LONG_ANSWER },
          { kind: "user_message", text: "and the second file?" },
          { kind: "assistant_message", text: "Same change, applied." },
        ],
      },
      { type: "state", state: baseState },
    ],
  },
  {
    label: "long messages: a fold undone by hand survives a transcript round trip",
    messages: [],
    beforeSnapshot: (window) => {
      window.document.querySelector(".bubble.user.folded .bubble-fold").click();
      // 切到别的 transcript 再回来：默认规则会重新折它，
      // 记下的手动决定必须优先。
      const replay = (transcriptId, events) =>
        window.dispatchEvent(new window.MessageEvent("message", { data: { type: "history", transcriptId, events } }));
      replay("other-session", []);
      replay("long-messages", [
        { kind: "user_message", text: LONG_PROMPT },
        { kind: "assistant_message", text: LONG_ANSWER },
        { kind: "user_message", text: "and the second file?" },
        { kind: "assistant_message", text: "Same change, applied." },
      ]);
    },
  },
  {
    label: "live streaming: thinking, tool call, text delta",
    messages: [
      { type: "state", state: { ...baseState, isStreaming: true } },
      { type: "event", event: { kind: "agent_start" } },
      { type: "event", event: { kind: "assistant_start" } },
      { type: "event", event: { kind: "thinking_delta", delta: "Considering options" } },
      { type: "event", event: { kind: "tool_start", id: "call-2", name: "bash", args: { cmd: "ls" } } },
      { type: "event", event: { kind: "tool_update", id: "call-2", text: "partial" } },
      { type: "event", event: { kind: "tool_end", id: "call-2", name: "bash", isError: true, text: "boom" } },
      // 技能归属：同一技能目录内的 SKILL.md 读取与辅助脚本执行
      // （徽章 + 资源面板的生效标记）。
      {
        type: "event",
        event: {
          kind: "tool_start",
          id: "call-3",
          name: "read",
          args: { path: "/workspace/.agents/skills/demo/SKILL.md" },
          skill: { name: "demo", kind: "load" },
        },
      },
      { type: "event", event: { kind: "tool_end", id: "call-3", name: "read", isError: false, text: "# Demo skill", skill: { name: "demo", kind: "load" } } },
      {
        type: "event",
        event: {
          kind: "tool_start",
          id: "call-4",
          name: "bash",
          args: { command: "python /workspace/.agents/skills/demo/scripts/run.py" },
          skill: { name: "demo", kind: "resource" },
        },
      },
      { type: "event", event: { kind: "tool_end", id: "call-4", name: "bash", isError: false, text: "ok", skill: { name: "demo", kind: "resource" } } },
      { type: "event", event: { kind: "text_delta", delta: "Here is the **result**." } },
      { type: "event", event: { kind: "queue_update", steering: ["steer me"], followUp: ["later"] } },
    ],
    beforeSnapshot: (window) => {
      const button = window.document.getElementById("btn-new");
      if (button.disabled) throw new Error("New must remain enabled while a top-level session is running");
      button.click();
    },
  },
  {
    // pi 扩展的工具没有专用卡片，宿主转发其自带的 `details` payload，
    // webview 画成通用树。覆盖标量、嵌套对象数组与空对象。
    label: "extension tool: structured details",
    messages: [
      { type: "event", event: { kind: "tool_start", id: "call-5", name: "web_search", args: { query: "pi agent" } } },
      {
        type: "event",
        event: {
          kind: "tool_end",
          id: "call-5",
          name: "web_search",
          isError: false,
          text: "2 results",
          details: {
            engine: "duckduckgo",
            elapsedMs: 412,
            cached: false,
            missing: null,
            results: [
              { title: "Pi docs", score: 0.91 },
              { title: "Pi repo", score: 0.77 },
            ],
            empty: {},
          },
        },
      },
    ],
  },
  {
    label: "manual compaction: input stays editable and submissions queue",
    messages: [
      { type: "state", state: { ...baseState, isCompacting: true } },
      { type: "event", event: { kind: "user_message", text: "continue after compaction", mode: "followUp" } },
      { type: "event", event: { kind: "queue_update", steering: [], followUp: ["continue after compaction"] } },
    ],
  },
  {
    label: "run finished: status + error notices",
    messages: [
      { type: "event", event: { kind: "assistant_end" } },
      { type: "event", event: { kind: "status", text: "compaction done" } },
      { type: "event", event: { kind: "error", text: "provider rejected the request" } },
      // 自动重试放弃：这条通知本身不带动作……
      { type: "event", event: { kind: "status", text: "retry failed: Connection error." } },
      {
        type: "event",
        event: {
          kind: "compaction_boundary",
          summary: "## Goal\nPreserve the current implementation context.\n\n## Next Steps\n1. Continue from the retained messages.",
          tokensBefore: 53200,
          estimatedTokensAfter: 18000,
        },
      },
      { type: "event", event: { kind: "agent_settled" } },
      // ……重发请求的提议改为收尾整个回合，等一切自动流程 settle 之后
      // 到来。它必须留在（折叠的）执行过程块之外，否则按钮够不着。
      {
        type: "event",
        event: {
          kind: "status",
          text: "The last request did not complete, so no reply arrived.",
          scope: "command",
          retry: "offered",
        },
      },
      { type: "state", state: baseState },
    ],
  },
];
