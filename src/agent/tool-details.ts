/**
 * Host-side sanitizing of `AgentToolResult.details` before it crosses into the
 * webview.
 *
 * Why this exists: `details` is whatever the tool author put there. Extensions
 * are the interesting case — a tool's `renderCall`/`renderResult` only ever
 * emit a pi-tui `Component` (ANSI lines), so its *presentation* cannot be
 * reused by a DOM host, but the data those functions were given can. Passing
 * `details` through lets the webview draw it in its own idiom instead of
 * showing nothing.
 *
 * Nothing here knows any specific extension's schema, by design: the output is
 * rendered as a generic tree.
 */

import type { JsonValue } from "../shared/protocol.js";

/**
 * Tools this webview draws a purpose-built card for. Their `details` is
 * implementation detail already covered by that card, so echoing a raw tree
 * underneath would be noise.
 *
 * The first seven are the tools pi ships (`core/tools/index.ts`).
 *
 * `subagent` is deliberately *not* here even though it has a card of
 * its own: that card is built *from* `details`, which is what carries the
 * per-lane state both while the call runs and when the transcript is replayed
 * later.
 *
 * Not an extension allow/deny list — extensions are exactly what this feature
 * is for.
 */
const TOOLS_WITH_DEDICATED_CARDS = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

/** Nesting past this is elided; deep trees are unreadable in a sidebar anyway. */
const MAX_DEPTH = 4;
/** Per-object / per-array cap, so one huge collection cannot flood the card. */
const MAX_ENTRIES = 50;
/** Long strings (file contents, logs) are truncated rather than dropped. */
const MAX_STRING_LENGTH = 2000;
/** Total budget across the whole tree, counted in serialized characters. */
const MAX_TOTAL_CHARS = 20000;

const ELIDED = "\u2026";

/**
 * Convert arbitrary tool `details` into structured-clone-safe JSON, or
 * `undefined` when there is nothing worth showing.
 *
 * Guards three ways VS Code's `postMessage` would otherwise fail or misbehave:
 * values it cannot clone (functions, symbols, class instances with accessors),
 * cycles, and unbounded size.
 */
export function sanitizeToolDetails(
  toolName: string,
  details: unknown,
): JsonValue | undefined {
  if (TOOLS_WITH_DEDICATED_CARDS.has(toolName)) return undefined;
  if (details === null || typeof details !== "object") return undefined;
  const budget = { remaining: MAX_TOTAL_CHARS };
  const value = sanitize(details, 0, new WeakSet(), budget);
  if (value === undefined) return undefined;
  // An empty object carries no information but would still draw a header row.
  if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0) {
    return undefined;
  }
  return value;
}

function sanitize(value: unknown, depth: number, seen: WeakSet<object>, budget: { remaining: number }): JsonValue | undefined {
  if (budget.remaining <= 0) return ELIDED;

  if (value === null) return null;

  switch (typeof value) {
    case "string": {
      const text = value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}${ELIDED}` : value;
      budget.remaining -= text.length;
      return text;
    }
    case "number":
      budget.remaining -= 8;
      // NaN/Infinity are valid JS but not JSON; show them rather than drop them.
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      budget.remaining -= 5;
      return value;
    case "bigint":
      budget.remaining -= 12;
      return `${value}n`;
    case "undefined":
    case "function":
    case "symbol":
      // Dropped: absent keys read better than a column of "[function]".
      return undefined;
  }

  const object = value as object;
  if (seen.has(object)) return "[circular]";
  // Say what was elided, so a cut branch does not read like an empty one.
  if (depth >= MAX_DEPTH) {
    return Array.isArray(object) ? `[${ELIDED} ${object.length} items]` : `{${ELIDED}}`;
  }

  // Common non-plain objects that would otherwise clone to `{}`.
  if (object instanceof Date) return object.toISOString();
  if (object instanceof Error) return `${object.name}: ${object.message}`;
  if (object instanceof RegExp) return String(object);

  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const items: JsonValue[] = [];
      for (const item of object.slice(0, MAX_ENTRIES)) {
        const clean = sanitize(item, depth + 1, seen, budget);
        // Holes would shift indices, so keep a placeholder for dropped items.
        items.push(clean === undefined ? null : clean);
        if (budget.remaining <= 0) break;
      }
      if (object.length > items.length) items.push(`${ELIDED} ${object.length - items.length} more`);
      return items;
    }

    if (object instanceof Map) {
      return sanitizeEntries([...object.entries()].map(([key, item]) => [String(key), item]), depth, seen, budget);
    }
    if (object instanceof Set) {
      return sanitize([...object], depth, seen, budget);
    }

    return sanitizeEntries(Object.entries(object as Record<string, unknown>), depth, seen, budget);
  } catch {
    // Getters can throw; a broken details object must not break the transcript.
    return undefined;
  } finally {
    seen.delete(object);
  }
}

function sanitizeEntries(
  entries: [string, unknown][],
  depth: number,
  seen: WeakSet<object>,
  budget: { remaining: number },
): JsonValue {
  const result: Record<string, JsonValue> = {};
  let count = 0;
  for (const [key, item] of entries) {
    if (count >= MAX_ENTRIES) {
      result[ELIDED] = `${entries.length - count} more`;
      break;
    }
    const clean = sanitize(item, depth + 1, seen, budget);
    if (clean === undefined) continue;
    budget.remaining -= key.length;
    result[key] = clean;
    count += 1;
    if (budget.remaining <= 0) break;
  }
  return result;
}
