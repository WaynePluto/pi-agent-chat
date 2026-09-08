/** 打包管线探针检查（宿主运行时、SDK、undici、jiti、剪贴板）。 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { describe } from "../errors.js";
import type { DiagnosticResult } from "../diagnostics.js";

/** 由 esbuild 注入（见 esbuild.mjs）。 */
declare const __PI_UNDICI_VERSION__: string;
declare const __PI_SDK_VERSION__: string;

export async function runSpikeDiagnostics(): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];

  results.push({
    name: "host runtime",
    ok: true,
    detail: `node ${process.versions.node}, electron ${process.versions.electron ?? "n/a"}, v8 ${process.versions.v8}`,
  });

  results.push({
    name: "sdk version",
    ok: true,
    detail: `${__PI_SDK_VERSION__} (bundled)`,
  });

  results.push(await checkUndici());
  results.push(await checkPackageAssets());
  results.push(await checkJiti());
  results.push(await checkClipboardNative());

  return results;
}

/** bundle 必须恰好含一份 undici，且 >= 8.7.0（代理转发修复）。 */
async function checkUndici(): Promise<DiagnosticResult> {
  const version = __PI_UNDICI_VERSION__;
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  const ok = major > 8 || (major === 8 && minor >= 7);
  const proxyEnv = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]
    .map((key) => (process.env[key] ? `${key}=${process.env[key]}` : undefined))
    .filter(Boolean)
    .join(", ");
  try {
    const undici = await import("undici");
    const hasProxyAgent = typeof undici.ProxyAgent === "function";
    return {
      name: "undici alias",
      ok: ok && hasProxyAgent,
      detail: `bundled ${version}${hasProxyAgent ? "" : " (ProxyAgent missing!)"}; proxy env: ${proxyEnv || "(none)"}`,
    };
  } catch (error) {
    return { name: "undici alias", ok: false, detail: `import failed: ${describe(error)}` };
  }
}

/** 打包可能破坏假定 SDK 磁盘布局的路径查找。 */
async function checkPackageAssets(): Promise<DiagnosticResult> {
  try {
    return {
      name: "sdk paths",
      ok: true,
      detail: `packageDir=${getPackageDir()}; agentDir=${getAgentDir()}`,
    };
  } catch (error) {
    return { name: "sdk paths", ok: false, detail: describe(error) };
  }
}

/** TypeScript 编写的扩展在运行时经 jiti 加载。 */
async function checkJiti(): Promise<DiagnosticResult> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-jiti-"));
    const file = join(dir, "probe.ts");
    await writeFile(file, "const value: number = 42;\nexport default value;\n", "utf8");
    const { createJiti } = await import("jiti/static");
    // `__filename` 存在，因为扩展 bundle 以 CJS 产出。
    const jiti = createJiti(__filename);
    const loaded = (await jiti.import(file, { default: true })) as number;
    return { name: "jiti .ts loading", ok: loaded === 42, detail: `loaded probe.ts -> ${String(loaded)}` };
  } catch (error) {
    return { name: "jiti .ts loading", ok: false, detail: describe(error) };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 图片粘贴用的可选原生依赖；必须优雅降级。 */
async function checkClipboardNative(): Promise<DiagnosticResult> {
  try {
    const mod = await import("@mariozechner/clipboard");
    return { name: "native clipboard (optional)", ok: true, detail: `loaded, exports: ${Object.keys(mod).join(", ") || "(none)"}` };
  } catch (error) {
    return { name: "native clipboard (optional)", ok: false, detail: `not loadable (image paste disabled): ${describe(error)}` };
  }
}
