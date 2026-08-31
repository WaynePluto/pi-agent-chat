/**
 * Webview characterization test.
 *
 * Loads the built `dist/webview.js` inside jsdom, replays a fixed sequence of
 * HostMessages and snapshots the resulting DOM structure. The snapshot is the
 * safety net for webview refactors: any unintended change to the rendered
 * transcript, composer, sessions page or resource panel shows up as a diff.
 *
 *   node scripts/smoke_webview.mjs            # compare against the baseline
 *   node scripts/smoke_webview.mjs --update   # rewrite the baseline (review the diff!)
 *
 * Intentionally free of any assertion framework: the whole project's test
 * strategy is "run it headless and diff the output".
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

// Session timestamps are rendered in the machine's own time zone, so the
// baseline would otherwise differ between developers. Pin it before anything
// constructs a Date; UTC keeps the recorded values equal to the fixtures.
process.env.TZ = "UTC";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = join(root, "dist", "webview.js");
const baselinePath = join(root, "scripts", "webview-snapshot.txt");
const update = process.argv.includes("--update");

/* ------------------------------------------------------------------ */
/* Fixture: one scripted session covering every renderer in the webview */
/* ------------------------------------------------------------------ */

const baseState = {
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

const PATCH = [
  "--- a/src/demo.ts",
  "+++ b/src/demo.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " const c = 4;",
].join("\n");

/* Message bubbles fold once they stop being the newest of their role, but only
   if they are long. One fixture per trigger: too many characters, too many
   lines (the second one also carries two fenced code blocks: a labelled one,
   which is highlighted and gets its own copy button, and an unlabelled one,
   which stays plain text because the language is never guessed). */
const LONG_PROMPT = "Refactor the transcript renderer and explain every step in detail. ".repeat(11);

/* A 1x1 PNG, base64. The snapshot only records that an <img> with a data: URL
   exists in the right place; the bytes themselves are irrelevant, and a real
   screenshot would bloat the baseline. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const LONG_ANSWER = [
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

const RESOURCE_SECTIONS = [
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

const MODEL_CATALOG = {
  items: [
    { provider: "test-provider", id: "test-model" },
    { provider: "test-provider", id: "other-model" },
    { provider: "second-provider", id: "cheap-model" },
  ],
};

/** Each step: a label plus the HostMessages delivered before the snapshot. */
const SCRIPT = [
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
    // The built-in subagent shadowing an extension's tool is a fact about the
    // session setup, so it belongs in the new-session notice — not in a
    // transcript event, which would evict that very placeholder and open a
    // bogus work block.
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
    // Same fact, different wording: with the tool off this session has no
    // delegation tool at all, so the notice must not promise one.
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
    // The feature is off by default and invisible without a shadowed
    // extension, so the empty-session notice is its only discovery point.
    label: "empty state: subagent off, nothing shadowed",
    messages: [{ type: "history", events: [], subagent: { enabled: false } }],
  },
  {
    // Enabled and nothing shadowed: no extra paragraph — the user turned it on
    // deliberately and the tool is visible in the resources panel.
    label: "empty state: subagent on, nothing shadowed",
    messages: [{ type: "history", events: [], subagent: { enabled: true } }],
  },
  {
    // The terminal tool gets the same treatment, and both notices can appear
    // at once: two independent tools, each with its own wording, so a session
    // that shadows one and disables the other must say both things.
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
    // Both tools off and nothing shadowed: the default state of a fresh
    // install, and the only place either feature is discoverable.
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
    // Re-opening must not duplicate the "other models" row.
    beforeMessages: (window) => window.document.getElementById("btn-model").click(),
    messages: [{ type: "models", catalog: { items: [] } }],
    beforeSnapshot: (window) => window.document.getElementById("btn-model").click(),
  },
  {
    label: "composer thinking menu",
    // Opening the second menu must replace the first one, not stack on it.
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
      // A reply is an addressable entry too: same three actions, in the gutter
      // on its right.
      if (assistant[0].dataset.entryId !== "entry-2") problems.push(`assistant bubble should get entry-2, got "${assistant[0].dataset.entryId}"`);
      if (assistant[0].querySelectorAll(".bubble-actions > .bubble-action").length !== 3) problems.push("assistant bubble should carry three actions");
      if (problems.length > 0) throw new Error(`entry id binding: ${problems.join("; ")}`);
    },
  },
  // Extension commands never reach the session file, so `bubbleEntryIds` has
  // no entry for them. The extension-command bubble must be skipped when
  // mapping ids by position, otherwise the real message after it shifts by
  // one and loses its action buttons.
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
  // Image attachments: the thumbnails must sit outside `.bubble-content` (the
  // element folding clips), and an attachment-only message must still render a
  // bubble even though its display text is empty — that bubble is what the
  // host's `bubbleEntryIds` counts, so losing it here would shift every entry
  // id after it.
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
  // Folding: only the newest message of each role stays open, and only long
  // messages fold at all (a folded one-liner would cost a click and save
  // nothing). The length test runs on the Markdown source precisely so that it
  // is reproducible here, where every element measures zero.
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
      // Away to another transcript and back: the default rule would fold this
      // bubble again, the remembered manual decision must outrank it.
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
      // Skill attribution: a SKILL.md read and a helper script run inside the
      // same skill directory (badges + the active mark in the resource panel).
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
    // A tool from a pi extension has no dedicated card, so the host forwards
    // its own `details` payload and the webview draws it as a generic tree.
    // Covers scalars, nested arrays of objects, and an empty object.
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
      // Automatic retry gave up: the notice itself carries no action ...
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
      // ... the offer to re-issue the request closes the turn instead, once
      // everything automatic has settled. It must stay out of the (collapsed)
      // work block, or the button would be unreachable.
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
  {
    label: "expanded cards: work block, tool card, resources",
    messages: [],
    // Card bodies render lazily; expanding them is the only way the snapshot
    // can cover tool args/output, diff rendering and the thinking card body.
    // The resources panel itself only enters the layout once its header button
    // is toggled on.
    beforeSnapshot: (window) => {
      window.document.getElementById("btn-resources").click();
      for (const selector of [".work-header", ".resources-toggle", ".resource-header", ".card-header"]) {
        for (const header of window.document.querySelectorAll(selector)) header.click();
      }
      // Nested blocks only exist once their parent body has rendered, so they
      // need a second pass: a tool's `details` tree lives inside a tool card.
      for (const header of window.document.querySelectorAll(".tool-details-block > .card-header")) header.click();
      // Resource updates and skill highlights both rebuild this panel. Expanded
      // sections must survive that rebuild instead of snapping shut.
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
    // The page must be open before the list arrives: `renderSessions` skips
    // rendering while hidden, exactly as it does in the real UI.
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
          // A task line whose parent went headless: both facts are true of
          // these rows, and the role is the more informative badge. The claim
          // still decides the click (it routes to the owning controller), so
          // naming the role costs nothing.
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
      // A lane of a headless parent must still read as a subagent, and clicking
      // it must address the owning controller rather than open a second writer.
      const foreignLane = window.document.querySelector(".session-row.claimed-background.delegation-child");
      const foreignLaneBadge = foreignLane?.querySelector(".session-badge");
      if (!foreignLaneBadge?.classList.contains("subagent")) {
        throw new Error("a running lane owned by another controller must keep the subagent badge");
      }
      // The click is recorded in the "posted to host" section of the snapshot:
      // it must address the owning controller (`revealSession`) rather than
      // resume the file, which would open a second writer for it.
      foreignLane.querySelector(".session-main").click();
      window.document.getElementById("btn-sessions").click();
    },
  },
  {
    label: "auth gate",
    messages: [{ type: "state", state: { ...baseState, needsAuth: true } }],
    beforeSnapshot: (window) => window.document.getElementById("btn-sessions").click(),
  },
  // Kept last: the resources message it needs would otherwise replace the
  // richer panel the earlier steps assert on.
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
  // Also last, for the same reason: it swaps the panel again.
  {
    label: "prompt template and extension invocations light up their resource rows",
    messages: [
      { type: "resources", sections: RESOURCE_SECTIONS },
      {
        type: "history",
        events: [
          // Expanded before the session stored it, so the bubble shows the body
          // while the panel still credits `/review`.
          { kind: "user_message", text: "Review the diff for regressions.", prompt: "review" },
          // An extension command runs without ever reaching the model.
          { kind: "user_message", text: "/ext-command", extension: "/workspace/.pi/extensions/ext.ts" },
          // A tool call credits the extension that registered it, through the
          // path both rows share.
          { kind: "tool_end", id: "call-2", name: "notify", isError: false, text: "sent", args: { message: "done" } },
          { kind: "assistant_message", text: "Nothing to flag." },
        ],
      },
      { type: "state", state: baseState },
    ],
    // Only the panel is toggled back into the layout: its expansion state (and
    // each section's) survives from the earlier steps.
    beforeSnapshot: (window) => window.document.getElementById("btn-resources").click(),
  },
  // The other half of the highlight: rows the host marks itself, for what the
  // transcript cannot show (context files that went out with a request, an
  // extension that only registers event handlers). The fresh history first
  // drops the transcript-derived marks of the step above.
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
  // A subagent whose live session is gone (window reloaded since the run) is
  // replayed from its session file. It must still read as that subagent, not as
  // a generic preview offering "back to the running session".
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
  // Stepping into a subagent and back rebuilds the parent transcript from
  // scratch. An execution process the user had opened must come back open:
  // silently re-collapsing it loses their place every time they look at a lane.
  {
    label: "return from a subagent: expanded work block and reading position kept",
    messages: [
      // Back on the parent, so the previous step's preview state does not bleed
      // into this snapshot.
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
      // Away to the subagent's transcript and back. The round trip is the point:
      // remembering only the current transcript would lose the expansion here.
      const replay = (transcriptId, events) =>
        window.dispatchEvent(new window.MessageEvent("message", { data: { type: "history", transcriptId, events } }));
      replay("/workspace/lane-a.jsonl", [{ kind: "user_message", text: "check the node version" }]);
      replay("parent-session", [
        { kind: "user_message", text: "check both versions" },
        { kind: "thinking_message", text: "Delegating." },
        { kind: "assistant_message", text: "Done." },
      ]);
      // Reading position is remembered alongside the expansion, for the message
      // list and for the execution process's own scroller. Asserted here rather
      // than in the DOM snapshot, which does not capture scroll offsets.
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
  // Transcript search: literal, case-insensitive matching over the visible
  // text, Enter/Shift+Enter navigation. jsdom has no CSS Custom Highlight API,
  // so what is asserted here is the counting/navigation half — the paint half
  // is a no-op there by design.
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
      // The input listener debounces the rebuild.
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 150));
      const count = () => document.getElementById("search-count").textContent;
      if (count() !== "3") throw new Error(`expected 3 matches, got "${count()}"`);
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      if (count() !== "1 of 3") throw new Error(`expected 1 of 3, got "${count()}"`);
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      if (count() !== "2 of 3") throw new Error(`expected 2 of 3, got "${count()}"`);
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
      if (count() !== "1 of 3") throw new Error(`expected 1 of 3 after Shift+Enter, got "${count()}"`);
      // Next/previous wrap around at both ends.
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
      if (count() !== "3 of 3") throw new Error(`expected wrap to 3 of 3, got "${count()}"`);
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      if (count() !== "1 of 3") throw new Error(`expected wrap to 1 of 3, got "${count()}"`);
    },
  },
  {
    // Closing restores the pre-search DOM: the bar is the same static markup,
    // hidden again, and the highlight registry never touched the transcript.
    label: "transcript search closed again",
    messages: [],
    beforeMessages: (window) => window.document.getElementById("search-close").click(),
  },
  {
    // Search reaches into collapsed executions through their data: the tool
    // output below never rendered (work blocks collapse by default), the query
    // still finds it, and landing on the hit opens the work block and the card
    // layer by layer. The snapshot shows the once-hidden body rendered.
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
      // Preconditions: a collapsed work block whose card body never rendered.
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
      // "helsinki" is only in the never-rendered output: the data layer's match.
      if (count() !== "1") throw new Error(`expected 1 match, got "${count()}"`);
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      if (count() !== "1 of 1") throw new Error(`expected 1 of 1, got "${count()}"`);
      // Both layers opened, and the body text landed in the DOM.
      if (work.classList.contains("collapsed")) throw new Error("work block did not expand");
      if (card.classList.contains("collapsed")) throw new Error("tool card did not expand");
      if (!card.textContent.includes("mirror helsinki-2 online")) throw new Error("card body did not render");
      // Close again so later sections do not carry the open bar.
      document.getElementById("search-close").click();
    },
  },
  {
    // A spent offer keeps its outcome on the button, drawn from the state the
    // host records on the notice: nothing rebuilds these cards on their own, so
    // a click that only changed the button locally would freeze on "Retrying".
    // The next step replaces the transcript, keeping this fixture isolated.
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
  // Near the end, because it replaces the transcript: steering splits the
  // execution process. The bubble floats while it is queued (the block above
  // still belongs to the interrupted run), and the moment the agent consumes it
  // that block must close, so the tool that follows opens a second block
  // *below* the bubble instead of being back-filled into the first one.
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
  // Last, because it wipes the transcript: "new session" has nothing to load,
  // so it must show the empty-session bubble straight away rather than flash
  // the loading spinner for one round trip.
  {
    label: "new session click: empty-session placeholder instead of a spinner",
    messages: [],
    beforeSnapshot: (window) => window.document.getElementById("btn-new").click(),
  },
  // Truly last: these two swap the module-level fold threshold, so they must
  // have nothing after them to disturb. The fold threshold is a VS Code
  // setting the webview cannot read, so the host pushes it (`foldThreshold`)
  // and then replays the transcript — the only way a bubble that already
  // exists re-decides whether it folds. 0 is the setting's "never fold"
  // value, from the issue that asked for the setting in the first place.
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
    // Back at the default the same transcript folds again — and ends the run
    // with the threshold at its default, which is what every other step
    // assumes.
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
  // Also last: input history is asserted in-script because the serializer
  // does not capture textarea values — a programmatic .value write never
  // becomes DOM text. The step drives the real keydown handlers through
  // sending, recalling, editing and sending again.
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

      // IME composition owns the arrows; jsdom only carries `isComposing`
      // through on versions that implement the full init dict.
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

      // Edits made to a recalled entry survive browsing away and back.
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
  // Opening a session feeds its user messages into the ↑ history (CLI
  // `populateHistory` parity); round trips and re-plays of the same transcript
  // must not stack a second copy. Asserted in-script: textarea values never
  // reach the DOM snapshot.
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
          // Queued/steered messages enter the history too, exactly as live sends do.
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

      // Start from an empty live composer: the previous step left a recalled
      // entry in it, and that text would otherwise become the saved draft.
      input.value = "";

      // Newest populated entry first, then the older one, then the ring that
      // was already there from the live sends of the previous step.
      press("ArrowUp");
      expectValue("populated newest", "beta question");
      press("ArrowUp");
      expectValue("populated older", "alpha question");
      press("ArrowUp");
      expectValue("pre-existing ring below", "second message, edited");

      // The same transcript re-played with the flag again (window start posts
      // attach, then ready): the per-transcript memory must keep the ring as
      // is — without it, consecutive-dedup would drop the duplicate "beta
      // question" and stack "alpha question" on top, so ↑ would land wrong.
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

      // A different transcript without the flag is a view round trip (lane /
      // preview): it never adds anything, agent-written lane tasks least of all.
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
  // Auto-folding is right only while the user is following the latest output.
  // Scrolled up they are reading something older — usually the very message
  // the rule wants to collapse — so the fold waits (`deferredFolds` in
  // transcript.ts) until following resumes. Following is switched off here the
  // only way it can be: an upward wheel, whose intent a scrollTop assignment
  // can never counterfeit. Last in the script, because these two steps replace
  // the displayed transcript and several scenarios above build on the one they
  // inherit.
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
  // Last, because it flips the module-level showThinking flag and restores it
  // only inside this step: with the setting on, a live thinking card opens
  // expanded, folds itself when its own stream ends, and the work block folds
  // when the block ends. Replay and tool cards are untouched by the setting,
  // which is why the fixture here is live `event` messages on an empty replay.
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
      // The user touches the card (close, then open again): from that moment
      // it is the user's, so the stream ending must not fold it — while the
      // work block still auto-folds at block end.
      const header = card.querySelector(".card-header");
      header.click();
      if (!card.classList.contains("collapsed")) throw new Error("user click should collapse the card");
      if (work.classList.contains("collapsed")) throw new Error("the block must not end from a card click");
      header.click();
      if (card.classList.contains("collapsed")) throw new Error("user click should re-open the card");
      // Formal text starts: the stream ends (card folds only if untouched) and
      // the block ends (it folds because it opened by setting).
      window.dispatchEvent(
        new window.MessageEvent("message", { data: { type: "event", event: { kind: "text_delta", delta: "Done." } } }),
      );
      if (!work.classList.contains("collapsed")) throw new Error("work block should collapse at block end");
      if (card.classList.contains("collapsed")) throw new Error("a card the user opened must not auto-collapse");
      // Restore everything this step touched, so the wide-layout snapshot the
      // script takes right after matches the pre-setting baseline byte for
      // byte: flag off, streaming off, and the transcript the "back at the
      // bottom" step left behind.
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

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/** Attributes that carry behaviour we care about; everything else is noise. */
const KEPT_ATTRIBUTES = ["id", "class", "title", "placeholder", "disabled", "hidden", "aria-expanded", "aria-pressed", "aria-checked", "type"];
/**
 * Classes that are pointer/scroll-driven decoration rather than structure.
 * `pi-scrolling` is put on whatever container was last scrolled and taken off
 * ~900ms later, so whether it is present in a snapshot depends on how long the
 * run took to get there -- a baseline that records it would fail on a slow
 * machine and pass on a fast one, for no change in behaviour.
 */
const TRANSIENT_CLASSES = new Set(["pi-scrolling"]);
const SPINNER_FRAMES = /[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f]/g;

function serialize(node, depth = 0, lines = []) {
  const indent = "  ".repeat(depth);
  if (node.nodeType === 3) {
    const text = node.textContent.replace(SPINNER_FRAMES, "\u280b").replace(/\s+/g, " ").trim();
    if (text) lines.push(`${indent}"${text}"`);
    return lines;
  }
  if (node.nodeType !== 1) return lines;

  const tag = node.tagName.toLowerCase();
  if (tag === "svg") {
    lines.push(`${indent}<svg/>`);
    return lines;
  }
  const attributes = KEPT_ATTRIBUTES.filter((name) => node.hasAttribute(name))
    .map((name) => {
      let value = node.getAttribute(name);
      if (name === "class" && value) {
        value = value
          .split(/\s+/)
          .filter((c) => c && !TRANSIENT_CLASSES.has(c))
          .join(" ");
        // Only vanishes when stripping emptied it; an element that always had
        // `class=""` keeps serializing as before.
        if (!value) return undefined;
      }
      return value === "" ? name : `${name}="${value}"`;
    })
    .filter((entry) => entry !== undefined)
    .join(" ");
  lines.push(`${indent}<${tag}${attributes ? ` ${attributes}` : ""}>`);
  for (const child of node.childNodes) serialize(child, depth + 1, lines);
  return lines;
}

function snapshot(window) {
  return serialize(window.document.getElementById("root")).join("\n");
}

async function flush(window) {
  // Let requestAnimationFrame / setTimeout(0) callbacks (streaming re-render,
  // autocomplete debounce) run before snapshotting.
  await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 5));
}

async function run() {
  if (!existsSync(bundlePath)) {
    console.error(`[fail] ${bundlePath} not found - run "pnpm build" first`);
    process.exit(1);
  }

  const dom = new JSDOM(`<!DOCTYPE html><html lang="en"><body class="surface-sidebar"><div id="root"></div></body></html>`, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // jsdom has no layout, but retaining the callback lets the characterization
  // drive the event-based wide/narrow mode switch and assert visibility/state.
  let resizeCallback;
  window.ResizeObserver = class {
    constructor(callback) {
      resizeCallback = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // jsdom's `pretendToBeVisual` requestAnimationFrame fires on a timer whose
  // latency relative to this harness's 5 ms flush varies by Node patch version
  // (22.22 vs 22.23 differ enough to flip whether a streaming re-render lands
  // before the snapshot). Run animation-frame callbacks as microtasks so the
  // rendered DOM is identical on every Node version; the batching that
  // `scheduleRender` performs within a synchronous burst is preserved because
  // microtasks drain after the current script, before the flush timeout.
  let rafId = 0;
  window.requestAnimationFrame = (callback) => {
    const id = ++rafId;
    queueMicrotask(() => callback(Date.now()));
    return id;
  };
  window.cancelAnimationFrame = () => {};
  const posted = [];
  // The persisted-state half of the api, as VS Code provides it: an opaque
  // object that survives webview reloads. Kept on the window so a test could
  // inspect it, but never pre-seeded — the smoke starts from a fresh webview.
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
      // The host always identifies the transcript it is replaying; the webview
      // keys per-transcript view state (expanded work blocks) off it. Default
      // one per step so scenarios stay isolated, and let a step opt into a
      // shared id when the point is that state survives a rebuild.
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
  // Put the narrow panel in a state the wide rail's defaults differ from, so
  // the assertions below tell "each mode keeps its own" apart from "the other
  // mode's state was inherited".
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
  // Reaching the threshold opens nothing. It only makes the rails *possible*:
  // a window resize must not rearrange the surface behind the user's back, and
  // the rails' own tracks stay collapsed until asked for.
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
  // The rail and the narrow panel are separate surfaces with separate state:
  // a rail the user opened comes up expanded whatever the narrow panel was.
  if (resourcesPanel()?.classList.contains("collapsed")) {
    throw new Error("the wide resources rail must open expanded");
  }
  sections.push(`===== wide layout: draggable rails, nothing auto-opened =====\n${snapshot(window)}`);

  // Every section rendered above was opened by hand, and such a decision is
  // the user's and shared by both modes, so the per-mode default needs a
  // section that has never been touched. The probe payload is dispatched after
  // the snapshot: it replaces the panel's contents (highlights included), and
  // only the collapse state the assertions below read survives a rebuild.
  const showResources = async (payload) => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "resources", sections: payload } }));
    await flush(window);
  };
  const probeSections = [{ name: "Probe", items: [{ label: "probe", scope: "builtin" }] }];
  const probeSection = () => window.document.querySelector(".resource-section");
  await showResources(probeSections);
  // A rail is opened to be read; showing only section headings would waste the
  // column the user just gave it.
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
  // Same probe on the other side: the narrow overlay sits on the transcript,
  // so it opens one level at a time.
  await showResources(probeSections);
  if (!probeSection()?.classList.contains("collapsed")) {
    throw new Error("an untouched section must default to collapsed in the narrow panel");
  }
  await showResources(RESOURCE_SECTIONS);
  resizeCallback?.([{ contentRect: { width: 1600 } }]);
  await flush(window);
  // Restoring is not auto-opening: the rails the user opened above come back,
  // because discarding a deliberate choice on every resize is its own bug.
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
  // Normalize CRLF so the comparison is stable on Windows checkouts with
  // core.autocrlf=true (the snapshot file is pinned to LF via .gitattributes,
  // but this guards against local clones without that rule).
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

await run();
