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

/** 从 node_modules 直接读包版本，不依赖包的 `exports` map。 */
function packageVersion(packageName) {
  try {
    const manifest = resolve(root, "node_modules", packageName, "package.json");
    return JSON.parse(readFileSync(manifest, "utf8")).version;
  } catch {
    return "unknown";
  }
}

/**
 * 必须留在 bundle 之外的模块：
 * - vscode：宿主提供
 * - photon-node / clipboard：原生 / wasm 资产按各自包目录相对解析
 *
 * jiti 故意打进 bundle：SDK 导入的是 ESM-only 的 `jiti/static` 入口，
 * CJS bundle 无法 `require()` 它。
 */
const external = ["vscode", "@silvia-odwyer/photon-node", "@mariozechner/clipboard"];

/**
 * SDK 用 `import.meta.url` 锚定路径，打成 CJS 后它会消失，故 `define` 把所有出现
 * 改写为 `__piSdkEntryUrl`，指向磁盘上的真 SDK：VSIX 内是 dist/node_modules/...，
 * 开发时是仓库自己的 node_modules/...。
 * 单个常量不够：多数 SDK 模块只要包根（docs/examples/themes/templates），但
 * core/extensions/loader.js 要用它推自己所在目录拼给 pi 扩展用的 jiti alias
 * （path.resolve(__dirname, "../..", "index.js")）——全都报入口的 URL 会高两层
 * （@earendil-works/index.js），import 该 SDK 的扩展一律加载失败。故下面的
 * sdkModuleUrlPlugin 经 `__piSdkModuleUrl` 给每个 SDK 模块自己的 URL。
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
 * 给每个打进 bundle 的 SDK 模块它自己文件的磁盘 URL，遮蔽 banner 定义的
 * 那个全局 `__piSdkEntryUrl`。
 * `define` 把 `import.meta.url` 变成裸的 `__piSdkEntryUrl` 引用，故模块作用域
 * 里同名常量即可完成改道：esbuild 的作用域分析把引用绑到最近的声明。
 * 缺了它，core/extensions/loader.js 会拼错 `@earendil-works/pi-coding-agent`
 * 的 jiti alias，import 该 SDK 的扩展全部死于
 * "Cannot find module .../@earendil-works/index.js"。
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
 * 这些包不打进 bundle、随 `dist/node_modules/` 发行，VSIX 才自给自足
 * （vsce 只剥掉仓库根的 node_modules）。清单与拷贝规则都在
 * scripts/runtime-packages.mjs，与证明清单完整的校验共用。
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
  // src/agent/http.ts（本仓库显式声明的 undici 依赖）会装全局代理 dispatcher，
  // 必须与 SDK 的 fetch 调用共用同一个 undici 实例。把所有 `import "undici"`
  // （含 SDK 的嵌套副本）alias 到顶层依赖，bundle 里就只嵌一份
  // （scripts/check_bundle.py 断言这一点，并强制 >= 8.7.0——代理绝对形式
  // 转发的修复版本）。
  alias: {
    undici: resolve(root, "node_modules", "undici"),
    // jsonc-parser 没有 exports map，platform:node 会选中其 UMD 构建，内部的
    // require("./impl/format") esbuild 跟不进去，bundle 加载即报
    // "Cannot find module ./impl/format"。钉到使用静态 import 的 ESM 构建。
    "jsonc-parser": resolve(root, "node_modules", "jsonc-parser", "lib", "esm", "main.js"),
  },
  logOverride: { "require-resolve-not-external": "silent" },
  plugins: [sdkModuleUrlPlugin],
  banner: { js: sdkEntryUrlBanner },
  define: {
    "process.env.NODE_ENV": production ? '"production"' : '"development"',
    "import.meta.url": "__piSdkEntryUrl",
    // 扩展加载器对包入口会回退到 import.meta.resolve()；CJS bundle 缺省把它
    // 置为 undefined，这里补上。
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

/** 把 SCSS 源码编译到 dist/main.css。 */
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
    // sass 给的 sources 是绝对 file:// URL；改写成相对 dist/ 的路径，DevTools
    // 才能在 webview（以及 scratch/repro.html）里解析它们。
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
  // 首次 SCSS 构建 + 简单的目录监听（sass 的 JS API 没有内置 watch）。
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
