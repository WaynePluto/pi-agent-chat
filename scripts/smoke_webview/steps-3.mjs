/* 脚本化会话的最后一段：transcript 搜索、重试提议、转向、折叠阈值、
   输入历史与延迟折叠。步骤按序执行，且建立在前面的步骤留下的
   DOM 之上。 */

import { baseState, LONG_PROMPT, LONG_ANSWER } from "./fixtures.mjs";

export const STEPS_3 = [
  // transcript 搜索：可见文本上的字面、大小写不敏感匹配，
  // Enter/Shift+Enter 导航。jsdom 没有 CSS Custom Highlight API，这里
  // 断言的是计数/导航那一半——绘制那一半在那里本来就是 no-op。
  {
    label: "transcript search: matches counted and navigated",
    messages: [
      {
        type: "history",
        events: [
          { kind: "user_message", text: "find alpha in the list" },
          { kind: "assistant_message", text: "alpha found: alpha-1 and beta." },
        ],
      },
    ],
    beforeSnapshot: async (window) => {
      const document = window.document;
      document.getElementById("btn-search").click();
      const input = document.getElementById("search-input");
      input.value = "ALPHA";
      input.dispatchEvent(new window.Event("input"));
      // 输入监听对重建做了防抖。
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 150));
      const count = () => document.getElementById("search-count").textContent;
      if (count() !== "3") throw new Error(`expected 3 matches, got "${count()}"`);
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      if (count() !== "1 of 3") throw new Error(`expected 1 of 3, got "${count()}"`);
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      if (count() !== "2 of 3") throw new Error(`expected 2 of 3, got "${count()}"`);
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
      if (count() !== "1 of 3") throw new Error(`expected 1 of 3 after Shift+Enter, got "${count()}"`);
      // 前后导航在两端循环。
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
      if (count() !== "3 of 3") throw new Error(`expected wrap to 3 of 3, got "${count()}"`);
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      if (count() !== "1 of 3") throw new Error(`expected wrap to 1 of 3, got "${count()}"`);
    },
  },
  {
    // 关闭恢复搜索前的 DOM：搜索条是同一份静态标记、重新藏起，
    // 高亮注册表从未碰过 transcript。
    label: "transcript search closed again",
    messages: [],
    beforeMessages: (window) => window.document.getElementById("search-close").click(),
  },
  {
    // 搜索经数据触达折叠的执行过程：下面的工具输出从未渲染（执行过程
    // 块默认折叠），查询仍能命中，落到命中项会逐层展开执行过程块与
    // 卡片。快照显示那个曾隐藏的 body 已渲染。
    label: "transcript search reveals a collapsed tool card",
    messages: [
      {
        type: "history",
        events: [
          { kind: "user_message", text: "list the mirrors" },
          { kind: "tool_start", id: "call-9", name: "bash", args: { command: "cat mirrors.txt" } },
          { kind: "tool_end", id: "call-9", name: "bash", isError: false, text: "mirror helsinki-2 online" },
        ],
      },
    ],
    beforeSnapshot: async (window) => {
      const document = window.document;
      // 前置条件：折叠的执行过程块，卡片 body 从未渲染。
      const work = document.querySelector(".work-block");
      if (!work || !work.classList.contains("collapsed")) throw new Error("expected a collapsed work block");
      const card = document.querySelector(".tool-card");
      if (!card || !card.classList.contains("collapsed")) throw new Error("expected a collapsed tool card");
      if (card.querySelector(":scope > .card-body").childElementCount !== 0) {
        throw new Error("expected an unrendered card body");
      }
      document.getElementById("btn-search").click();
      const input = document.getElementById("search-input");
      input.value = "helsinki";
      input.dispatchEvent(new window.Event("input"));
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 150));
      const count = () => document.getElementById("search-count").textContent;
      // "helsinki" 只在从未渲染的输出里：数据层的命中。
      if (count() !== "1") throw new Error(`expected 1 match, got "${count()}"`);
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      if (count() !== "1 of 1") throw new Error(`expected 1 of 1, got "${count()}"`);
      // 两层都展开，正文文本落进 DOM。
      if (work.classList.contains("collapsed")) throw new Error("work block did not expand");
      if (card.classList.contains("collapsed")) throw new Error("tool card did not expand");
      if (!card.textContent.includes("mirror helsinki-2 online")) throw new Error("card body did not render");
      // 再关掉，后续小节不带开着的搜索条。
      document.getElementById("search-close").click();
    },
  },
  {
    // 已用掉的提议把结局留在按钮上，按宿主记录在通知上的状态绘制：
    // 没有谁会自己重建这些卡片，只改本地按钮状态的点击会永远冻在
    // "Retrying"。下一步替换 transcript，让这个 fixture 保持隔离。
    label: "retry offer outcomes",
    messages: [
      {
        type: "history",
        transcriptId: "retry-outcomes",
        events: [
          { kind: "status", text: "The last request did not complete, so no reply arrived.", scope: "command", retry: "running" },
          { kind: "status", text: "The last request did not complete, so no reply arrived.", scope: "command", retry: "succeeded" },
          { kind: "status", text: "The last request did not complete, so no reply arrived.", scope: "command", retry: "failed" },
        ],
      },
      { type: "state", state: baseState },
    ],
  },
  // 靠后，因为它会替换 transcript：转向分割执行过程。气泡排队期间漂浮
  // （上面的块仍属于被打断的运行），agent 消费它的那一刻该块必须关闭，
  // 随后的工具在气泡*下方*另开第二块，而不是回填进第一块。
  {
    label: "steering: the consumed message ends the execution process",
    messages: [
      { type: "history", transcriptId: "steering-session", events: [] },
      { type: "state", state: { ...baseState, isStreaming: true } },
      { type: "event", event: { kind: "user_message", text: "list the files" } },
      { type: "event", event: { kind: "tool_start", id: "steer-1", name: "bash", args: { command: "ls" } } },
      { type: "event", event: { kind: "tool_end", id: "steer-1", name: "bash", isError: false, text: "a.ts" } },
      { type: "event", event: { kind: "user_message", text: "actually, only the tests", mode: "steer" } },
      { type: "event", event: { kind: "queue_update", steering: ["actually, only the tests"], followUp: [] } },
      { type: "event", event: { kind: "queue_update", steering: [], followUp: [] } },
      { type: "event", event: { kind: "tool_start", id: "steer-2", name: "bash", args: { command: "ls test" } } },
      { type: "event", event: { kind: "tool_end", id: "steer-2", name: "bash", isError: false, text: "a.test.ts" } },
    ],
  },
  // 放最后，因为它清空 transcript：「新建会话」没有东西可加载，必须
  // 直接显示空会话气泡，而不是为一次往返闪一帧加载转圈。
  {
    label: "new session click: empty-session placeholder instead of a spinner",
    messages: [],
    beforeSnapshot: (window) => window.document.getElementById("btn-new").click(),
  },
  // 真正的最后：这两步交换模块级折叠阈值，其后不能再有会被打扰的
  // 步骤。折叠阈值是 webview 读不到的 VS Code 设置，由宿主推送
  // （`foldThreshold`）再重放 transcript——已存在的气泡重新判定折不折
  // 只有这一条路。0 是该设置的「永不折叠」值，出自当初要求这个设置
  // 的 issue。
  {
    label: "fold threshold 0: superseded long messages stay open",
    messages: [
      { type: "foldThreshold", maxLines: 0 },
      {
        type: "history",
        transcriptId: "fold-off",
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
    // 恢复默认后同一 transcript 重新折叠——并以默认阈值收尾整个运行，
    // 其余步骤都以此为前提。
    label: "fold threshold restored: folding resumes",
    messages: [
      { type: "foldThreshold", maxLines: 14 },
      {
        type: "history",
        transcriptId: "fold-off",
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
  // 同样放最后：输入历史在脚本内断言，因为序列化器不记 textarea 的
  // 值——程序化写 .value 永远不会变成 DOM 文本。本步骤驱动真实
  // keydown 处理器：发送、回溯、编辑、再发送。
  {
    label: "composer input history via ArrowUp / ArrowDown",
    messages: [{ type: "state", state: baseState }],
    beforeSnapshot: (window) => {
      const input = window.document.getElementById("input");
      const type = (text) => {
        input.value = text;
        input.setSelectionRange(text.length, text.length);
      };
      const press = (key, init = {}) =>
        input.dispatchEvent(new window.KeyboardEvent("keydown", { key, ...init }));
      const problems = [];
      const expectValue = (label, expected) => {
        if (input.value !== expected) problems.push(`${label}: got "${input.value}", expected "${expected}"`);
      };

      type("first message");
      press("Enter");
      type("second message");
      press("Enter");

      // IME 组合期间方向键归输入法；jsdom 只在实现完整 init dict 的
      // 版本上才透传 `isComposing`。
      if (new window.KeyboardEvent("keydown", { isComposing: true }).isComposing === true) {
        press("ArrowUp", { isComposing: true });
        expectValue("ime composition ignored", "");
      }

      press("ArrowUp");
      expectValue("recall newest", "second message");
      press("ArrowUp");
      expectValue("recall older", "first message");
      press("ArrowUp");
      expectValue("no wrap past the oldest", "first message");
      press("ArrowDown");
      expectValue("forward to newest", "second message");
      press("ArrowDown");
      expectValue("back to the draft", "");
      press("ArrowDown");
      expectValue("nothing below live input", "");

      type("half-written draft");
      press("ArrowUp");
      expectValue("draft saved when leaving live input", "second message");
      press("ArrowDown");
      expectValue("draft restored", "half-written draft");

      // 对回溯条目的编辑在来回浏览后保留。
      press("ArrowUp");
      type("second message, edited");
      press("ArrowUp");
      expectValue("one older", "first message");
      press("ArrowDown");
      expectValue("edit kept on return", "second message, edited");
      press("Enter");
      press("ArrowUp");
      expectValue("after sending, newest first", "second message, edited");

      if (problems.length > 0) throw new Error(`input history: ${problems.join("; ")}`);
    },
  },
  // 打开会话把它的用户消息灌进 ↑ 历史（对齐 CLI 的 `populateHistory`）；
  // 同一 transcript 的往返与重放不得再堆一份。在脚本内断言：
  // textarea 的值进不了 DOM 快照。
  {
    label: "input history populated from an opened session",
    messages: [
      {
        type: "history",
        transcriptId: "populate-1",
        populateInputHistory: true,
        events: [
          { kind: "user_message", text: "alpha question" },
          { kind: "assistant_message", text: "alpha answer" },
          // 排队/转向消息同样进历史，与实时发送完全一致。
          { kind: "user_message", text: "beta question", mode: "followUp" },
          { kind: "assistant_message", text: "beta answer" },
        ],
      },
      { type: "state", state: baseState },
    ],
    beforeSnapshot: (window) => {
      const input = window.document.getElementById("input");
      const press = (key) =>
        input.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
      const replay = (data) =>
        window.dispatchEvent(new window.MessageEvent("message", { data }));
      const problems = [];
      const expectValue = (label, expected) => {
        if (input.value !== expected) problems.push(`${label}: got "${input.value}", expected "${expected}"`);
      };

      // 从空的 composer 起步：上一步在里面留了一条回溯条目，
      // 不清空它就会变成保存的草稿。
      input.value = "";

      // 先是最新灌入的，再旧的，然后是上一步实时发送留下的既有环。
      press("ArrowUp");
      expectValue("populated newest", "beta question");
      press("ArrowUp");
      expectValue("populated older", "alpha question");
      press("ArrowUp");
      expectValue("pre-existing ring below", "second message, edited");

      // 同一 transcript 带标志再次重放（窗口启动先发 attach 再发
      // ready）：按 transcript 的记忆必须保持环原样——没有它，连续
      // 去重会丢掉重复的 "beta question" 再把 "alpha question" 堆上去，
      // ↑ 就落错位置。
      press("ArrowDown");
      expectValue("forward one", "alpha question");
      press("ArrowDown");
      expectValue("forward two", "beta question");
      press("ArrowDown");
      expectValue("back to live", "");
      replay({ type: "history", transcriptId: "populate-1", populateInputHistory: true, events: [] });
      press("ArrowUp");
      expectValue("re-played transcript did not stack", "beta question");
      press("ArrowUp");
      expectValue("older entry still in place", "alpha question");

      // 不带标志的另一个 transcript 只是视图往返（lane/preview）：
      // 它什么都不加，agent 写的 lane 任务更不该加。
      press("ArrowDown");
      press("ArrowDown");
      expectValue("back to live again", "");
      replay({
        type: "history",
        transcriptId: "populate-2",
        events: [{ kind: "user_message", text: "lane task written by the parent" }],
      });
      press("ArrowUp");
      expectValue("unflagged replay added nothing", "beta question");

      if (problems.length > 0) throw new Error(`history populate: ${problems.join("; ")}`);
    },
  },
  // 自动折叠只在用户跟随最新输出时是对的。滚上去时他在读更旧的内容
  // ——往往恰是规则要折的那条——折叠于是等待（transcript.ts 的
  // `deferredFolds`），直到恢复跟随。这里用唯一可行的办法关掉跟随：
  // 向上滚轮，它的意图是 scrollTop 赋值伪造不了的。放脚本最后：
  // 这两步替换显示中的 transcript，而上面若干场景建立在它们继承的
  // 那份之上。
  {
    label: "reading further up: a superseded long message is not folded away",
    messages: [
      {
        type: "history",
        transcriptId: "deferred-fold",
        events: [
          { kind: "user_message", text: "walk me through it" },
          { kind: "assistant_message", text: LONG_ANSWER },
        ],
      },
      { type: "state", state: baseState },
    ],
    beforeSnapshot: (window) => {
      const messages = window.document.getElementById("messages");
      messages.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -120 }));
      messages.dispatchEvent(new window.Event("scroll"));
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: { type: "event", event: { kind: "assistant_message", text: LONG_PROMPT } },
        }),
      );
      const folded = window.document.querySelectorAll(".bubble.assistant.folded").length;
      if (folded !== 0) throw new Error(`no assistant bubble may fold while scrolled up, got ${folded}`);
    },
  },
  {
    label: "back at the bottom: the deferred fold is applied",
    messages: [],
    beforeSnapshot: (window) => {
      window.document.getElementById("scroll-down").click();
      const bubbles = [...window.document.querySelectorAll(".bubble.assistant")];
      if (!bubbles[0].classList.contains("folded")) throw new Error("the superseded answer should fold on resume");
      if (bubbles[1].classList.contains("folded")) throw new Error("the newest answer must stay open");
    },
  },
  // 放最后：它翻转模块级 showThinking 标志且只在本步骤内恢复。设置
  // 开启时，实时思考卡片展开开场、自己的流结束时自行折叠、执行过程
  // 块在块结束时折叠。回放与工具卡片不受该设置影响，所以这里的
  // fixture 是空回放之上的实时 `event` 消息。
  {
    label: "showThinking on: thinking streams expanded, folds at stream and block end",
    messages: [
      { type: "history", transcriptId: "show-thinking", events: [] },
      { type: "showThinking", enabled: true },
      { type: "state", state: { ...baseState, isStreaming: true } },
      { type: "event", event: { kind: "agent_start" } },
      { type: "event", event: { kind: "thinking_delta", delta: "Weighing the options" } },
    ],
    beforeSnapshot: (window) => {
      const document = window.document;
      const work = document.querySelector(".work-block");
      const card = document.querySelector(".thinking-card");
      if (!work || !card) throw new Error("expected a live work block with a thinking card");
      if (work.classList.contains("collapsed")) throw new Error("work block should stay expanded while streaming");
      if (card.classList.contains("collapsed")) throw new Error("thinking card should stay expanded while its stream runs");
      // 用户碰卡片（合再开）：从那一刻起它归用户，流结束不得折叠它
      // ——执行过程块仍在块结束时自动折叠。
      const header = card.querySelector(".card-header");
      header.click();
      if (!card.classList.contains("collapsed")) throw new Error("user click should collapse the card");
      if (work.classList.contains("collapsed")) throw new Error("the block must not end from a card click");
      header.click();
      if (card.classList.contains("collapsed")) throw new Error("user click should re-open the card");
      // 正式文本开始：流结束（卡片仅在未被碰过时折叠）、块结束
      // （因设置而展开过的它折叠）。
      window.dispatchEvent(
        new window.MessageEvent("message", { data: { type: "event", event: { kind: "text_delta", delta: "Done." } } }),
      );
      if (!work.classList.contains("collapsed")) throw new Error("work block should collapse at block end");
      if (card.classList.contains("collapsed")) throw new Error("a card the user opened must not auto-collapse");
      // 恢复本步骤碰过的一切，让脚本紧接着拍的宽屏快照与设置前基线
      // 逐字节一致：标志关、流式关、transcript 回到「回到底部」那步
      // 留下的样子。
      window.dispatchEvent(new window.MessageEvent("message", { data: { type: "showThinking", enabled: false } }));
      window.dispatchEvent(new window.MessageEvent("message", { data: { type: "state", state: baseState } }));
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: {
            type: "history",
            transcriptId: "deferred-fold",
            events: [
              { kind: "user_message", text: "walk me through it" },
              { kind: "assistant_message", text: LONG_ANSWER },
            ],
          },
        }),
      );
      window.dispatchEvent(
        new window.MessageEvent("message", {
          data: { type: "event", event: { kind: "assistant_message", text: LONG_PROMPT } },
        }),
      );
      window.document.getElementById("scroll-down").click();
    },
  },
];
