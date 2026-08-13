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
    label: "empty state: overridden system prompt warning",
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
        shadowedSubagent: { path: "/home/u/.pi/agent/extensions/subagent/index.ts", subagentEnabled: false },
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
        shadowedSubagent: { path: "/home/u/.pi/agent/extensions/subagent/index.ts", subagentEnabled: true },
      },
    ],
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
      { type: "entryIds", ids: ["entry-1", "entry-2"], labels: [undefined, "before refactor"] },
      { type: "state", state: baseState },
    ],
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
          { file: "/workspace/b.jsonl", title: "older session", timestamp: "2026-01-01T00:00:00.000Z", current: false },
          {
            file: "/workspace/c.jsonl",
            title: "delegated child",
            timestamp: "2026-01-03T00:00:00.000Z",
            current: false,
            delegationRole: "child",
          },
        ],
      },
    ],
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
  // Last, because it wipes the transcript: "new session" has nothing to load,
  // so it must show the empty-session bubble straight away rather than flash
  // the loading spinner for one round trip.
  {
    label: "new session click: empty-session placeholder instead of a spinner",
    messages: [],
    beforeSnapshot: (window) => window.document.getElementById("btn-new").click(),
  },
];

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/** Attributes that carry behaviour we care about; everything else is noise. */
const KEPT_ATTRIBUTES = ["id", "class", "title", "placeholder", "disabled", "hidden", "aria-expanded", "aria-pressed", "aria-checked", "type"];
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
      const value = node.getAttribute(name);
      return value === "" ? name : `${name}="${value}"`;
    })
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

  const dom = new JSDOM(`<!DOCTYPE html><html lang="en"><body><div id="root"></div></body></html>`, {
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  // jsdom has no ResizeObserver; the responsive collapse it drives is a layout
  // concern jsdom could not evaluate anyway (every element measures 0).
  window.ResizeObserver = class {
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
  window.acquireVsCodeApi = () => ({ postMessage: (message) => posted.push(message) });

  window.eval(readFileSync(bundlePath, "utf8"));

  const sections = [];
  for (const [index, step] of SCRIPT.entries()) {
    step.beforeMessages?.(window);
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
    step.beforeSnapshot?.(window);
    await flush(window);
    sections.push(`===== ${step.label} =====\n${snapshot(window)}`);
  }

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
