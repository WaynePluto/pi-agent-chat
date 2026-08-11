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
    label: "delegation: child session displayed",
    messages: [
      {
        type: "state",
        state: {
          ...baseState,
          isStreaming: true,
          inputDisabled: true,
          delegation: { role: "child", title: "research task", peerSessionId: "session-0", peerSessionFile: "/p.jsonl" },
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
  for (const step of SCRIPT) {
    step.beforeMessages?.(window);
    for (const message of step.messages) {
      window.dispatchEvent(new window.MessageEvent("message", { data: message }));
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
