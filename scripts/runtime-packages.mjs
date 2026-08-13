/**
 * Single source of truth for the packages that ship *unbundled* under
 * `dist/node_modules/`, plus the copying rules for them.
 *
 * They cannot be bundled: the SDK's extension loader hands jiti a set of
 * aliases anchored on the SDK entry's `import.meta.url`, so a pi extension's
 * `import "@earendil-works/pi-ai"` is resolved against the real file system,
 * not against anything esbuild produced. Whatever those on-disk copies import
 * in turn must therefore also exist on disk.
 *
 * Shared by `esbuild.mjs` (which copies them for production builds) and
 * `scripts/check_extension_runtime.mjs` (which proves the list is complete).
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Entry points a pi extension is allowed to import (the SDK's jiti aliases).
 * These are what must resolve on disk for any extension to load at all.
 */
export const extensionVisibleEntries = [
  "@earendil-works/pi-coding-agent/dist/index.js",
  "@earendil-works/pi-agent-core/dist/index.js",
  "@earendil-works/pi-ai/dist/index.js",
  "@earendil-works/pi-tui/dist/index.js",
];

export const runtimePackages = [
  "@earendil-works/pi-coding-agent",
  // Resolved from disk by the SDK's extension loader (jiti aliases anchored on
  // the SDK entry's import.meta.url): extensions import these at runtime.
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-ai",
  "typebox",
  "jiti",
  "@silvia-odwyer/photon-node",
  "@mariozechner/clipboard",
  // Transitive dependencies of the SDK packages above. Bundling does not cover
  // them: an extension's `import "@earendil-works/pi-ai"` goes through jiti to
  // the *on-disk* copy, whose own `import "partial-json"` then resolves
  // against `dist/node_modules` with nothing to fall back on. Without these,
  // any extension touching the SDK dies with "Cannot find module".
  //
  // This is the closure of the static load path, not the full dependency tree:
  // the provider SDKs (@anthropic-ai/sdk, openai, @google/genai,
  // @mistralai/mistralai, @aws-sdk/client-bedrock-runtime, ~35 MB) are
  // imported lazily by pi-ai and are never reached at import time.
  "@earendil-works/pi-telemetry",
  "balanced-match",
  "brace-expansion",
  "chalk",
  "cross-spawn",
  "diff",
  "get-east-asian-width",
  "glob",
  "graceful-fs",
  "grok-mermaid",
  "highlight.js",
  "hosted-git-info",
  "ignore",
  "isexe",
  "lru-cache",
  "marked",
  "minimatch",
  "partial-json",
  "path-key",
  "proper-lockfile",
  "retry",
  "semver",
  "shebang-command",
  "shebang-regex",
  "signal-exit",
  "undici",
  "which",
  "yaml",
];

/** Native clipboard bindings live in platform-specific sibling packages. */
export function platformClipboardPackages() {
  const manifest = resolve(repoRoot, "node_modules", "@mariozechner", "clipboard", "package.json");
  try {
    return Object.keys(JSON.parse(readFileSync(manifest, "utf8")).optionalDependencies ?? {});
  } catch {
    return [];
  }
}

/**
 * Copy the runtime packages into `target`.
 *
 * Nested `node_modules` are dropped on purpose: keeping them would let a
 * package satisfy its own dependency locally and hide a missing entry in
 * `runtimePackages`, which is exactly the failure this layout has to rule out.
 */
export async function copyRuntimePackages(target, { log = () => {} } = {}) {
  await rm(target, { recursive: true, force: true });
  const skipped = [];
  for (const name of runtimePackages) {
    const source = resolve(repoRoot, "node_modules", name);
    try {
      await mkdir(dirname(join(target, name)), { recursive: true });
      await cp(source, join(target, name), {
        recursive: true,
        // Type declarations and maps are dead weight at runtime.
        filter: (path) => {
          const rel = path.slice(source.length);
          if (/[\\/]node_modules[\\/]|\.map$|\.d\.ts$|\.d\.mts$|\.d\.cts$/.test(rel)) return false;
          // The clipboard npm wrapper ships Rust sources and build files that
          // are never needed at runtime; keep only the JS loader and manifest.
          if (source === resolve(repoRoot, "node_modules", "@mariozechner", "clipboard")) {
            if (/[\\/]src[\\/]|Cargo\.toml$|build\.rs$|exp\.ts$|\.yarnrc\.yml$/.test(rel)) return false;
          }
          return true;
        },
      });
    } catch (error) {
      skipped.push(name);
      log(`skipped runtime package ${name}: ${error.message}`);
    }
  }
  for (const name of platformClipboardPackages()) {
    try {
      await cp(resolve(repoRoot, "node_modules", name), join(target, name), { recursive: true });
    } catch {
      // Optional dependency for other platforms; ignore when absent.
    }
  }
  return { skipped };
}
