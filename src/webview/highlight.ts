/**
 * Syntax highlighting for fenced code blocks.
 *
 * Three decisions worth keeping:
 *
 *  - **highlight.js, not shiki.** Shiki reproduces VS Code's own grammars, but
 *    it ships TextMate grammars plus a WASM regex engine (megabytes, loaded
 *    asynchronously) and it still could not reproduce the user's editor colors,
 *    because a webview has no access to the active theme's token colors. The
 *    remaining difference is not worth that weight in a sidebar.
 *  - **A hand-picked language set**, registered against `highlight.js/lib/core`.
 *    The full bundle carries 190+ grammars for a chat panel that mostly shows
 *    code from this project's own stack.
 *  - **Only what the fence declares.** An unknown or missing language is left
 *    as plain text instead of running auto-detection, which guesses badly on
 *    the short snippets a chat produces \u2014 wrong colors read as wrong code.
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

/* Aliases (`ts`, `sh`, `yml`, `html`, ...) come with each grammar. */
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
 * Highlighting the same code twice is common: a streaming answer re-renders its
 * whole Markdown on every frame, and only the last block is actually changing.
 */
const cache = new Map<string, string>();
const MAX_CACHED_BLOCKS = 64;

/**
 * Highlighted HTML for a fenced block, or `undefined` to leave it as plain text
 * (unknown language, or a block too large to be worth the work on every frame).
 *
 * The returned markup is produced by highlight.js from a plain-text input and
 * is HTML-escaped by it, which is what makes it safe to assign as `innerHTML`
 * after the sanitizer has already reduced the block to text.
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
    // A block that is still streaming is usually syntactically incomplete;
    // `ignoreIllegals` keeps it colored instead of dropping back to plain text
    // for every intermediate frame.
    html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return undefined;
  }

  cache.set(key, html);
  if (cache.size > MAX_CACHED_BLOCKS) cache.delete(cache.keys().next().value as string);
  return html;
}
