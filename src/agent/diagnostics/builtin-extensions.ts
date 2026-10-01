/** SDK 内置扩展（codemode / tool-search / mcp）装载与部署的自检。 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { builtinExtensions } from "../builtin-extensions.js";
import { describe } from "../errors.js";
import type { DiagnosticResult } from "../diagnostics.js";

/**
 * CLI 自带的 codemode / tool-search / mcp 内置扩展必须在插件会话里同样
 * 装载（共享 `mcp.json` / `codemode.mode` / `defaultTools` 在两个宿主同一
 * 份语义）；`builtin:` 路径的扩展必须 `hidden`（CLI 启动清单不列它们，
 * 资源面板同样不列）。codemode 的 QuickJS worker 与 wasm 是磁盘资产：
 * worker 由 pi-codemode 模块自己的 `import.meta.url` 定位（bundle 内经
 * esbuild.mjs 回填，见 sdkModuleUrlPlugin），wasm 从 SDK 入口锚点解析——
 * 两者缺一，codemode 第一次跑脚本即失败。
 */
export async function runBuiltinExtensionTest(cwd: string): Promise<DiagnosticResult[]> {
  let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
  try {
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { extensionFactories: builtinExtensions },
    });
    const { extensions, errors } = services.resourceLoader.getExtensions();
    const builtin = (name: string) => extensions.find((extension) => extension.path === `builtin:${name}`);
    const notHidden: string[] = [];
    for (const { name } of builtinExtensions) {
      const extension = builtin(name);
      if (extension && extension.hidden !== true) notHidden.push(extension.path);
    }

    ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd) }));
    const registered = (name: string) => session?.getToolDefinition(name) !== undefined;
    const mcpCommand = builtin("mcp")?.commands.has("mcp") === true;

    /* 无参数 `/mcp` 在非 TUI 宿主走 `ctx.ui.notify(状态汇总)` 的降级分支
       （管理器视图是 pi-tui 组件）；真跑一次命令分发，钉住它在本宿主可用。 */
    await session.bindExtensions({ mode: "rpc", onError: () => {} });
    let mcpDisposition: string | undefined;
    try {
      await session.prompt("/mcp", {
        preflightResult: (disposition) => (mcpDisposition = disposition),
      });
    } catch {
      mcpDisposition = "threw";
    }

    /* pi-codemode 的 worker 与 quickjs 的 wasm 都按磁盘位置消费：从 SDK
       入口（bundle 内 import.meta.url 即它）向上找同 scope 的包目录。 */
    const entryDir = dirname(fileURLToPath(import.meta.url));
    const require = createRequire(import.meta.url);
    let workerPath: string | undefined;
    for (let dir = entryDir; ; ) {
      const candidate = join(dir, "@earendil-works", "pi-codemode", "dist", "runtime", "worker.js");
      if (existsSync(candidate)) {
        workerPath = candidate;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    let wasmPath: string | undefined;
    try {
      wasmPath = require.resolve("quickjs-wasi/quickjs.wasm");
    } catch {
      wasmPath = undefined;
    }

    const missing = builtinExtensions
      .filter(({ name }) => builtin(name) === undefined)
      .map(({ name }) => name);
    const toolsMissing = ["codemode", "tool_search"].filter((name) => !registered(name));
    const ok =
      missing.length === 0 &&
      toolsMissing.length === 0 &&
      mcpCommand &&
      mcpDisposition === "handled" &&
      notHidden.length === 0 &&
      workerPath !== undefined &&
      wasmPath !== undefined &&
      errors.length === 0;
    return [{
      name: "builtin extensions",
      ok,
      detail:
        `loaded: ${builtinExtensions.map(({ name }) => `${name}=${builtin(name) !== undefined}`).join(", ")}; ` +
        `tools: ${toolsMissing.length === 0 ? "codemode, tool_search registered" : `missing ${toolsMissing.join(", ")}`}; ` +
        `/mcp command=${mcpCommand}; /mcp dispatch=${mcpDisposition ?? "(none)"}; hidden=${notHidden.length === 0}; ` +
        `codemode worker=${workerPath ? "found" : "MISSING"}; quickjs wasm=${wasmPath ? "found" : "MISSING"}`,
    }];
  } catch (error) {
    return [{ name: "builtin extensions", ok: false, detail: describe(error) }];
  } finally {
    session?.dispose();
  }
}
