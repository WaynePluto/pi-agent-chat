/* 脚本化会话的共享 fixture 数据：每步起始的基础状态，加上各步骤回放用
   的文本、资源与模型常量。被 step 模块与 harness 引用。 */

/* ------------------------------------------------------------------ */
/* Fixture：一个脚本化会话，覆盖 webview 的每个渲染器                  */
/* ------------------------------------------------------------------ */

export const baseState = {
  ready: true,
  cwd: "/workspace",
  sessionFile: "/workspace/.pi/session.jsonl",
  sessionId: "session-1",
  modelId: "test-model",
  providerId: "test-provider",
  thinkingLevel: "medium",
  thinkingLevels: ["off", "low", "medium", "high"],
  isStreaming: false,
  isCompacting: false,
  needsAuth: false,
  messageCount: 2,
  stats: {
    inputTokens: 12_345,
    outputTokens: 678,
    cacheRead: 1_000,
    cacheWrite: 2_000,
    cacheHitPercent: 7.5,
    cost: 0.0123,
    contextPercent: 42.5,
    contextWindow: 200_000,
  },
};

export const PATCH = [
  "--- a/src/demo.ts",
  "+++ b/src/demo.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
].join("\n");

/* 消息气泡不再是本角色最新一条时折叠，但仅在够长时。每个触发条件一个
   fixture：字符过多、行数过多（后者还带两个围栏代码块：标注语言的那个
   会被高亮并获得复制按钮，未标注的保持纯文本——语言从不猜）。 */
export const LONG_PROMPT = "Refactor the transcript renderer and explain every step in detail. ".repeat(11);

/* 1x1 PNG 的 base64。快照只记录带 data: URL 的 <img> 出现在正确位置；
   字节本身无关紧要，真截图只会撑大基线。 */
export const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
export const LONG_ANSWER = [
  "Here is the plan.",
  "",
  "```ts",
  "const a = 1;",
  "const b = 2;",
  "```",
  "",
  "```",
  "an unlabelled block stays plain text",
  "```",
  "",
  "- read the current renderer",
  "- extract the bubble into its own module",
  "- fold long messages",
  "- add the copy buttons",
  "- update the styles",
  "- rebuild the snapshot",
  "- review the diff",
  "",
  "That is all.",
].join("\n");

export const RESOURCE_SECTIONS = [
  { name: "Context", items: [{ label: "AGENTS.md", path: "/workspace/AGENTS.md", scope: "project" }] },
  {
    name: "Skills",
    items: [
      { label: "demo", path: "/workspace/.agents/skills/demo/SKILL.md", scope: "project" },
      { label: "helper", path: "/home/me/.agents/skills/helper/SKILL.md", scope: "global" },
    ],
  },
  {
    name: "Prompts",
    items: [{ label: "/review", path: "/workspace/.pi/prompts/review.md", scope: "project" }],
  },
  {
    name: "Extensions",
    items: [
      { label: "broken.ts (load failed)", detail: "broken.ts: parse failed", inactive: true, scope: "project" },
      { label: "ext.ts", path: "/workspace/.pi/extensions/ext.ts", scope: "project" },
      { label: "notify.ts", path: "/home/me/.pi/agent/extensions/notify.ts", scope: "global" },
    ],
  },
  {
    name: "Tools",
    items: [
      { label: "bash", scope: "builtin", hint: "Execute a bash command" },
      { label: "grep", scope: "builtin", hint: "Search file contents", inactive: true },
      { label: "notify", path: "/home/me/.pi/agent/extensions/notify.ts", scope: "global", hint: "Send a desktop notification" },
      { label: "subagent", scope: "builtin", hint: "Delegate one task to a child agent session" },
    ],
  },
];

export const MODEL_CATALOG = {
  items: [
    { provider: "test-provider", id: "test-model" },
    { provider: "test-provider", id: "other-model" },
    { provider: "second-provider", id: "cheap-model" },
  ],
};
