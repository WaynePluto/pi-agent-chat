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
  isStreaming: false,
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

/** Each step: a label plus the HostMessages delivered before the snapshot. */
const SCRIPT = [
  {
    label: "startup: resources + commands + empty state",
    messages: [
      {
        type: "resources",
        sections: [
          { name: "Context", items: ["AGENTS.md"], details: ["/workspace/AGENTS.md"] },
          { name: "Skills", items: ["demo"], details: ["/workspace/.agents/skills/demo/SKILL.md", "broken.md: parse failed"] },
        ],
      },
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
    label: "live streaming: thinking, tool call, text delta",
    messages: [
      { type: "state", state: { ...baseState, isStreaming: true } },
      { type: "event", event: { kind: "agent_start" } },
      { type: "event", event: { kind: "assistant_start" } },
      { type: "event", event: { kind: "thinking_delta", delta: "Considering options" } },
      { type: "event", event: { kind: "tool_start", id: "call-2", name: "bash", args: { cmd: "ls" } } },
      { type: "event", event: { kind: "tool_update", id: "call-2", text: "partial" } },
      { type: "event", event: { kind: "tool_end", id: "call-2", name: "bash", isError: true, text: "boom" } },
      { type: "event", event: { kind: "text_delta", delta: "Here is the **result**." } },
      { type: "event", event: { kind: "queue_update", steering: ["steer me"], followUp: ["later"] } },
    ],
  },
  {
    label: "run finished: status + error notices",
    messages: [
      { type: "event", event: { kind: "assistant_end" } },
      { type: "event", event: { kind: "status", text: "compaction done" } },
      { type: "event", event: { kind: "error", text: "provider rejected the request" } },
      { type: "event", event: { kind: "agent_settled" } },
      { type: "state", state: baseState },
    ],
  },
  {
    label: "expanded cards: work block, tool card, resources",
    messages: [],
    // Card bodies render lazily; expanding them is the only way the snapshot
    // can cover tool args/output, diff rendering and the thinking card body.
    beforeSnapshot: (window) => {
      for (const selector of [".work-header", ".resources-toggle", ".resource-header", ".card-header"]) {
        for (const header of window.document.querySelectorAll(selector)) header.click();
      }
    },
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
];

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/** Attributes that carry behaviour we care about; everything else is noise. */
const KEPT_ATTRIBUTES = ["id", "class", "title", "placeholder", "disabled", "hidden", "aria-expanded", "type"];
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
