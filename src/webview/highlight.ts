/**
 * fence 代码块的语法高亮，三个值得留下的决定：用 highlight.js 而非
 * shiki——shiki 复现 VS Code 语法，但要带 TextMate 语法包与 WASM 引擎
 * （MB 级、异步加载），而 webview 反正拿不到主题 token 颜色，差异不值
 * 这个体积；手选语言子集注册进 `highlight.js/lib/core`，全量包要为聊天
 * 面板背上 190+ 语法；只高亮 fence 声明的语言，未知或缺失就保持纯文本
 * ——自动检测在聊天的短片段上猜得很差，错的颜色会被读成错的代码。
 */

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

import { MAX_HIGHLIGHT_CHARS } from "./format.js";

/* 别名（`ts`、`sh`、`yml`、`html`…）随各语法包自带。 */
const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  lua,
  markdown,
  php,
  powershell,
  python,
  ruby,
  rust,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};

for (const [name, definition] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, definition);

/**
 * 同一段代码高亮两次很常见：流式回答每帧重渲染整段 Markdown，而真正在
 * 变的只有最后一个块。
 */
const cache = new Map<string, string>();
const MAX_CACHED_BLOCKS = 64;

/**
 * fence 块的高亮 HTML；返回 `undefined` 表示保持纯文本（未知语言，或块
 * 大到不值得每帧做一遍）。
 *
 * 返回的 markup 由 highlight.js 从纯文本生成、经它转义，这正是净化器已把
 * 块还原为文本后仍可安全赋给 `innerHTML` 的原因。
 */
export function highlightCode(code: string, language: string | undefined): string | undefined {
  if (!language || code.length > MAX_HIGHLIGHT_CHARS) return undefined;
  const resolved = hljs.getLanguage(language)?.name;
  if (!resolved) return undefined;

  const key = `${language}\u0000${code}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let html: string;
  try {
    // 流式中的块常在语法上不完整；`ignoreIllegals` 让它保持上色，而不是
    // 每个中间帧都退回纯文本。
    html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return undefined;
  }

  cache.set(key, html);
  if (cache.size > MAX_CACHED_BLOCKS) cache.delete(cache.keys().next().value as string);
  return html;
}
