import { createRequire } from "node:module";
import { cp, mkdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url));

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/** Read a package version from node_modules without relying on its `exports` map. */
function packageVersion(packageName) {
  try {
    const manifest = resolve(root, "node_modules", packageName, "package.json");
    return JSON.parse(readFileSync(manifest, "utf8")).version;
  } catch {
    return "unknown";
  }
}

/**
 * Modules that must stay outside the bundle:
 * - vscode: provided by the host
 * - photon-node / clipboard: native / wasm assets resolved relative to their package dir
 *
 * `jiti` is intentionally bundled: the SDK imports the ESM-only `jiti/static`
 * entry point, which cannot be `require()`d from a CJS bundle.
 */
const external = ["vscode", "@silvia-odwyer/photon-node", "@mariozechner/clipboard"];

/**
 * The SDK anchors package-relative paths (docs, examples, themes, templates) on
 * `import.meta.url`. Bundling to CJS erases that, so we redirect it to the real
 * on-disk SDK entry point: `dist/node_modules/...` in a packaged VSIX, or the
 * repository's own `node_modules/...` during development.
 */
const sdkEntryUrlBanner = `const __piSdkEntryUrl = (() => {
  const nodePath = require("node:path");
  const nodeFs = require("node:fs");
  const nodeUrl = require("node:url");
  const parts = ["@earendil-works", "pi-coding-agent", "dist", "index.js"];
  const candidates = [
    nodePath.join(__dirname, "node_modules", ...parts),
    nodePath.join(__dirname, "..", "node_modules", ...parts),
  ];
  const found = candidates.find((candidate) => nodeFs.existsSync(candidate)) ?? candidates[1];
  return nodeUrl.pathToFileURL(found).href;
})();
const __piSdkResolve = (specifier) => {
  const nodePath = require("node:path");
  const nodeFs = require("node:fs");
  const nodeUrl = require("node:url");
  const req = require("node:module").createRequire(__piSdkEntryUrl);
  try {
    return nodeUrl.pathToFileURL(req.resolve(specifier)).href;
  } catch {
    // require.resolve() cannot see import-only "exports" conditions; resolve
    // the subpath manually from the package manifest. Locate the package dir
    // by walking node_modules upwards (exports maps rarely expose package.json).
    const parts = specifier.split("/");
    const pkgName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    const subpath = "." + specifier.slice(pkgName.length);
    let dir = nodePath.dirname(nodeUrl.fileURLToPath(__piSdkEntryUrl));
    let pkgDir;
    while (true) {
      const candidate = nodePath.join(dir, "node_modules", ...pkgName.split("/"));
      if (nodeFs.existsSync(nodePath.join(candidate, "package.json"))) { pkgDir = candidate; break; }
      const parent = nodePath.dirname(dir);
      if (parent === dir) throw new Error("Cannot locate package " + pkgName + " for " + specifier);
      dir = parent;
    }
    const manifest = JSON.parse(nodeFs.readFileSync(nodePath.join(pkgDir, "package.json"), "utf8"));
    const pick = (value) => {
      if (typeof value === "string") return value;
      if (value && typeof value === "object") return pick(value.import) ?? pick(value.default) ?? pick(value.require);
      return undefined;
    };
    const exportsMap = manifest.exports ?? {};
    let target = pick(exportsMap[subpath]);
    if (!target) {
      // Wildcard patterns, e.g. "./providers/*" matching "./providers/all".
      for (const [pattern, value] of Object.entries(exportsMap)) {
        const star = pattern.indexOf("*");
        if (star === -1) continue;
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= prefix.length + suffix.length) {
          const wildcard = subpath.slice(prefix.length, subpath.length - suffix.length);
          const resolved = pick(value);
          if (resolved) { target = resolved.replaceAll("*", wildcard); break; }
        }
      }
    }
    if (!target) throw new Error("Cannot resolve " + specifier + " from " + pkgDir);
    return nodeUrl.pathToFileURL(nodePath.join(pkgDir, target)).href;
  }
};`;

/**
 * Packages that stay outside the bundle and are resolved from disk at runtime.
 * They are copied into `dist/node_modules/` for production builds so a VSIX is
 * self-contained (vsce only strips `node_modules` at the repository root).
 */
const runtimePackages = [
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
];

/** Copy runtime packages into dist/, skipping nested deps, sources and maps. */
async function copyRuntimePackages() {
  const target = resolve(root, "dist", "node_modules");
  await rm(target, { recursive: true, force: true });
  for (const name of runtimePackages) {
    const source = resolve(root, "node_modules", name);
    try {
      await mkdir(dirname(join(target, name)), { recursive: true });
      await cp(source, join(target, name), {
        recursive: true,
        // Nested deps are already bundled; type declarations and maps are dead weight.
        filter: (path) => {
          const rel = path.slice(source.length);
          if (/[\\/]node_modules[\\/]|\.map$|\.d\.ts$|\.d\.mts$|\.d\.cts$/.test(rel)) return false;
          // The clipboard npm wrapper ships Rust sources and build files that
          // are never needed at runtime; keep only the JS loader and manifest.
          if (source === resolve(root, "node_modules", "@mariozechner", "clipboard")) {
            if (/[\\/]src[\\/]|Cargo\.toml$|build\.rs$|exp\.ts$|\.yarnrc\.yml$/.test(rel)) return false;
          }
          return true;
        },
      });
    } catch (error) {
      console.warn(`[esbuild] skipped runtime package ${name}: ${error.message}`);
    }
  }
  // Native clipboard bindings live in platform-specific sibling packages.
  for (const name of platformClipboardPackages()) {
    const source = resolve(root, "node_modules", name);
    try {
      await cp(source, join(target, name), { recursive: true });
    } catch {
      // Optional dependency for other platforms; ignore when absent.
    }
  }
  console.log(`[esbuild] copied runtime packages into dist/node_modules`);
}

function platformClipboardPackages() {
  const manifest = resolve(root, "node_modules", "@mariozechner", "clipboard", "package.json");
  try {
    return Object.keys(JSON.parse(readFileSync(manifest, "utf8")).optionalDependencies ?? {});
  } catch {
    return [];
  }
}

/** @type {import("esbuild").BuildOptions} */
const extensionConfig = {
  entryPoints: [resolve(root, "src/extension.ts")],
  outfile: resolve(root, "dist/extension.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: !production,
  minify: production,
  external,
  // `src/agent/http.ts` (this repo's explicit undici dependency) installs a
  // global proxy dispatcher and must share one undici instance with the SDK's
  // fetch calls. Alias every `import "undici"` — including the SDK's nested
  // copy — to the top-level dependency so exactly one undici is embedded
  // (asserted by scripts/check_bundle.py, which also enforces >= 8.7.0 for
  // the proxy absolute-form forwarding fix).
  alias: {
    undici: resolve(root, "node_modules", "undici"),
  },
  logOverride: { "require-resolve-not-external": "silent" },
  banner: { js: sdkEntryUrlBanner },
  define: {
    "process.env.NODE_ENV": production ? '"production"' : '"development"',
    "import.meta.url": "__piSdkEntryUrl",
    // The extension loader falls back to import.meta.resolve() for package
    // entry points; CJS bundles otherwise leave it undefined.
    "import.meta.resolve": "__piSdkResolve",
    __PI_UNDICI_VERSION__: JSON.stringify(packageVersion("undici")),
    __PI_SDK_VERSION__: JSON.stringify(packageVersion("@earendil-works/pi-coding-agent")),
  },
};

/** @type {import("esbuild").BuildOptions} */
const webviewConfig = {
  entryPoints: [resolve(root, "src/webview/main.ts")],
  outfile: resolve(root, "dist/webview.js"),
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "iife",
  sourcemap: !production,
  minify: production,
};

if (watch) {
  const contexts = await Promise.all([esbuild.context(extensionConfig), esbuild.context(webviewConfig)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("[esbuild] watching...");
} else {
  if (production) await rm(resolve(root, "dist"), { recursive: true, force: true });
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
  if (production) await copyRuntimePackages();
  console.log("[esbuild] build complete");
}
