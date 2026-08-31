/**
 * Verify that the unbundled packages shipped in a VSIX are self-sufficient.
 *
 * Why this needs its own check: pi extensions are loaded by the SDK through
 * jiti, which resolves `@earendil-works/pi-ai` & co. to the *copies on disk*
 * under `dist/node_modules/`, not to anything inside the bundle. Those copies
 * carry their own bare imports (`partial-json`, `yaml`, `chalk`, ...), so
 * every one of those has to ship too.
 *
 * The gap is invisible during development: run from the repository, Node walks
 * up from `dist/node_modules/` and finds this project's own `node_modules/`,
 * so everything resolves. It only surfaces after `vsce package` — which strips
 * the root-level `node_modules` — as "Cannot find module 'partial-json'" when
 * a user's extension touches the SDK.
 *
 * So this builds the shipping layout from `runtimePackages` in a sandbox
 * outside the repository, where no such fallback exists, and imports the entry
 * points an extension is allowed to import. It deliberately does not read
 * `dist/node_modules`: that directory is only populated by production builds,
 * and a stale copy would make this pass for the wrong reason.
 *
 * Entry-point imports alone are not enough: pi-ai hides every provider SDK
 * behind a `lazyApi(() => import("./<api>.js"))` facade, so `openai` & co. are
 * never resolved while loading the entries — only when something calls the
 * api through the on-disk copy, at which point the module's top-level
 * `import OpenAI from "openai"` fails with exactly the error users see in a
 * packaged VSIX ("Cannot find package 'openai' imported from
 * .../pi-ai/dist/api/openai-completions.js"). The probe therefore also imports
 * every provider module in `pi-ai/dist/api/`, executing those top-level
 * imports against the sandboxed layout.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { copyRuntimePackages, extensionVisibleEntries, runtimePackages } from "./runtime-packages.mjs";

function fail(message) {
  console.error(`[fail] ${message}`);
  process.exit(1);
}

const sandbox = join(tmpdir(), `pi-vsix-runtime-${process.pid}`);
const target = join(sandbox, "dist", "node_modules");

try {
  await mkdir(dirname(target), { recursive: true });
  const { skipped } = await copyRuntimePackages(target);
  if (skipped.length > 0) fail(`runtime packages not installed: ${skipped.join(", ")}`);

  const missingEntries = extensionVisibleEntries.filter((entry) => !existsSync(join(target, entry)));
  if (missingEntries.length > 0) fail(`entry points missing from the shipped layout: ${missingEntries.join(", ")}`);

  // A child process keeps Node from caching failed specifier resolutions, and
  // keeps a broken SDK from taking this script down with it.
  const probe = join(sandbox, "probe.mjs");
  const providerModules = readdirSync(join(target, "@earendil-works", "pi-ai", "dist", "api"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => pathToFileURL(join(target, "@earendil-works", "pi-ai", "dist", "api", name)).href);
  await writeFile(
    probe,
    [
      ...extensionVisibleEntries.map((entry) => `await import(${JSON.stringify(pathToFileURL(join(target, entry)).href)});`),
      ...providerModules.map((href) => `await import(${JSON.stringify(href)});`),
    ].join("\n"),
    "utf8",
  );

  try {
    execFileSync(process.execPath, [probe], { stdio: "pipe" });
  } catch (error) {
    const output = `${error.stderr ?? ""}${error.stdout ?? ""}`;
    const missing = /Cannot find (?:package|module) '([^']+)'/.exec(output);
    if (missing) {
      fail(
        `on-disk SDK cannot resolve '${missing[1]}' — add it to runtimePackages in scripts/runtime-packages.mjs.\n` +
          "       Extensions import the SDK from disk via jiti, so its dependencies must ship too.",
      );
    }
    fail(`loading the on-disk SDK failed:\n${output.split("\n").slice(0, 8).join("\n")}`);
  }

  console.log(
    `[ok]   ${runtimePackages.length} unbundled packages self-sufficient ` +
      `(${extensionVisibleEntries.length} SDK entries + ${providerModules.length} provider modules load)`,
  );
} finally {
  await rm(sandbox, { recursive: true, force: true }).catch(() => {});
}
