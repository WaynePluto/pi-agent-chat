/**
 * `AgentToolResult.details` 跨进 webview 前的宿主侧清洗。
 *
 * 存在理由：`details` 是工具作者放进去的任意东西。扩展是有意思的情形——
 * 工具的 `renderCall`/`renderResult` 只产出 pi-tui `Component`（ANSI 行），
 * 其「呈现」无法被 DOM 宿主复用，但喂给它们的数据可以。透传 `details`
 * 让 webview 用自己的语言去画，而不是什么都不显示。
 *
 * 这里刻意不认任何具体扩展的 schema：输出渲染为通用树。
 */

import type { JsonValue } from "../shared/protocol.js";

/**
 * 本 webview 为其画专用卡片的工具（前七个即 pi 自带工具，
 * `core/tools/index.ts`）。它们的 `details` 是已被卡片覆盖的实现细节，
 * 在下面再回显一棵原始树只是噪声。
 *
 * `subagent` 刻意不在列中，尽管它有自己的卡片：那张卡片正是用
 * `details` 画的——运行期间与事后回放，每路子代理的状态都靠它携带。
 * 这不是扩展的允许/拒绝清单——扩展恰恰是这个功能存在的理由。
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

/** 超过此深度的嵌套省略；深树在侧栏里反正读不动。 */
const MAX_DEPTH = 4;
/** 每对象/数组的条目上限，防单个大集合刷爆卡片。 */
const MAX_ENTRIES = 50;
/** 长字符串（文件内容、日志）截断而不是丢弃。 */
const MAX_STRING_LENGTH = 2000;
/** 整棵树的总额预算，按序列化字符数计。 */
const MAX_TOTAL_CHARS = 20000;

const ELIDED = "\u2026";

/**
 * 把任意工具 `details` 转成可结构化克隆的安全 JSON；
 * 没有值得展示的内容时返回 `undefined`。
 *
 * 挡住 VS Code `postMessage` 会失败或出问题的三种情况：
 * 克隆不了的值（函数、symbol、带 getter 的类实例）、循环引用、无上限的体积。
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
  // 空对象没有任何信息，却仍会画出一行标题。
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
      // NaN/Infinity 是合法 JS 但不是 JSON；展示而不是丢弃。
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
      // 丢弃：键缺失比一列 "[function]" 好读。
      return undefined;
  }

  const object = value as object;
  if (seen.has(object)) return "[circular]";
  // 说明省略了什么，免得被剪的分支读成空分支。
  if (depth >= MAX_DEPTH) {
    return Array.isArray(object) ? `[${ELIDED} ${object.length} items]` : `{${ELIDED}}`;
  }

  // 常见的非普通对象，否则会被克隆成 `{}`。
  if (object instanceof Date) return object.toISOString();
  if (object instanceof Error) return `${object.name}: ${object.message}`;
  if (object instanceof RegExp) return String(object);

  seen.add(object);
  try {
    if (Array.isArray(object)) {
      const items: JsonValue[] = [];
      for (const item of object.slice(0, MAX_ENTRIES)) {
        const clean = sanitize(item, depth + 1, seen, budget);
        // 稀疏空洞会让索引错位，被丢的条目保留占位符。
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
    // getter 可能抛错；一个坏的 details 对象不能弄坏 transcript。
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
