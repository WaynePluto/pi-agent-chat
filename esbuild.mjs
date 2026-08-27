import { createRequire } from "node:module";
import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import * as sass from "sass";
import { copyRuntimePackages, runtimePackages } from "./scripts/runtime-packages.mjs";

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
 * The SDK anchors paths on `import.meta.url`. Bundling to CJS erases that, so
 * `define` rewrites every occurrence to `__piSdkEntryUrl`, pointing at the real
 * on-disk SDK: `dist/node_modules/...` in a packaged VSIX, or the repository's
 * own `node_modules/...` during development.
 *
 * One constant is not enough, though. Most SDK modules only want the package
 * root (docs, examples, themes, templates), but `core/extensions/loader.js`
 * derives its *own* directory from it to build the jiti aliases handed to pi
 * extensions:
 *
 *   const packageIndex = path.resolve(__dirname, "../..", "index.js");
 *
 * With every module reporting the entry's URL that lands two levels too high
 * (`@earendil-works/index.js`), and any extension importing
 * `@earendil-works/pi-coding-agent` fails to load. So `sdkModuleUrlPlugin`
 * below gives each SDK module its own URL through `__piSdkModuleUrl`, which is
 * both correct for the loader and strictly more accurate for everyone else.
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
};
const __piSdkModuleUrl = (relative) => {
  const nodePath = require("node:path");
  const nodeUrl = require("node:url");
  const distDir = nodePath.dirname(nodeUrl.fileURLToPath(__piSdkEntryUrl));
  return nodeUrl.pathToFileURL(nodePath.join(distDir, relative)).href;
};`;

/**
 * Give every bundled SDK module the URL of its own file on disk, shadowing the
 * single `__piSdkEntryUrl` the banner defines.
 *
 * `define` turns `import.meta.url` into a bare `__piSdkEntryUrl` reference, so
 * a module-scoped constant of that name is enough to redirect it: esbuild's
 * scope analysis binds the reference to the nearest declaration.
 *
 * Without this, `core/extensions/loader.js` mis-resolves the jiti alias for
 * `@earendil-works/pi-coding-agent`, and every extension importing it dies
 * with "Cannot find module .../@earendil-works/index.js".
 */
const sdkModuleUrlPlugin = {
  name: "pi-sdk-module-url",
  setup(build) {
    const sdkDist = resolve(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist");
    build.onLoad({ filter: /\.js$/ }, async (args) => {
      if (!args.path.startsWith(sdkDist + sep)) return undefined;
      const source = await readFile(args.path, "utf8");
      if (!source.includes("import.meta.url")) return undefined;
      const relativePath = relative(sdkDist, args.path).split(sep).join("/");
      return {
        contents: `const __piSdkEntryUrl = __piSdkModuleUrl(${JSON.stringify(relativePath)});\n${source}`,
        loader: "js",
      };
    });
  },
};

/**
 * Packages that ship unbundled under `dist/node_modules/` so a VSIX is
 * self-contained (vsce only strips `node_modules` at the repository root).
 * The list and the copying rules live in `scripts/runtime-packages.mjs`,
 * shared with the check that proves the list is complete.
 */
async function copyRuntimePackagesIntoDist() {
  const { skipped } = await copyRuntimePackages(resolve(root, "dist", "node_modules"), {
    log: (message) => console.warn(`[esbuild] ${message}`),
  });
  console.log(`[esbuild] copied ${runtimePackages.length - skipped.length} runtime packages into dist/node_modules`);
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
    // jsonc-parser has no "exports" map, so platform:node picks its UMD build,
    // whose internal `require("./impl/format")` esbuild cannot follow: the
    // bundle then fails to load with "Cannot find module ./impl/format".
    // Point at the ESM build, which uses static imports.
    "jsonc-parser": resolve(root, "node_modules", "jsonc-parser", "lib", "esm", "main.js"),
  },
  logOverride: { "require-resolve-not-external": "silent" },
  plugins: [sdkModuleUrlPlugin],
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

/** Compile SCSS sources into dist/main.css. */
async function compileSass() {
  const entry = resolve(root, "src/styles/main.scss");
  const result = sass.compile(entry, {
    style: production ? "compressed" : "expanded",
    sourceMap: !production,
  });
  await mkdir(resolve(root, "dist"), { recursive: true });
  const withMapLink =
    result.sourceMap && !production
      ? `${result.css}\n/*# sourceMappingURL=main.css.map */\n`
      : result.css;
  await writeFile(resolve(root, "dist/main.css"), withMapLink);
  if (result.sourceMap && !production) {
    // Sources are absolute file:// URLs from sass; rewrite to paths relative to
    // dist/ so DevTools resolves them in the webview (and in scratch/repro.html).
    const map = {
      ...result.sourceMap,
      sources: result.sourceMap.sources.map((s) =>
        s.startsWith("file://")
          ? relative(resolve(root, "dist"), fileURLToPath(s)).split(sep).join("/")
          : s,
      ),
    };
    await writeFile(resolve(root, "dist/main.css.map"), JSON.stringify(map));
  }
}

if (watch) {
  const contexts = await Promise.all([esbuild.context(extensionConfig), esbuild.context(webviewConfig)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  // Initial SCSS build + simple poll watcher (sass has no built-in watch).
  await compileSass();
  const { watch: fsWatch } = await import("node:fs");
  fsWatch(resolve(root, "src/styles"), { recursive: true }, async () => {
    try { await compileSass(); } catch (e) { console.error("[sass]", e.message); }
  });
  console.log("[esbuild] watching...");
} else {
  if (production) await rm(resolve(root, "dist"), { recursive: true, force: true });
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig), compileSass()]);
  if (production) await copyRuntimePackagesIntoDist();
  console.log("[esbuild] build complete");
}
