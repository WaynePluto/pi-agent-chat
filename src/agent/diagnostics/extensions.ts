/** 扩展加载、重载与扩展命令上下文的自检。 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe } from "../errors.js";
import { PiRuntime } from "../runtime.js";
import { SubagentCoordinator } from "../subagent.js";
import type { DiagnosticResult } from "../diagnostics.js";

/** 一个像真实扩展那样 import SDK 的 pi 扩展。 */
const SDK_IMPORT_PROBE_EXTENSION = `import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "sdk_import_probe",
    label: "SDK import probe",
    description: String(typeof getAgentDir),
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "probe" }], details: {} }),
  });
}
`;

/**
 * 扩展必须能 `import "@earendil-works/pi-coding-agent"`。只在 bundle 内有
 * 意义：扩展由 jiti 对着磁盘上的 SDK 加载，别名源自 SDK 的
 * import.meta.url——打包成 CJS 会抹掉它，esbuild.mjs 负责重建。弄错则
 * 别名指向不存在的路径，每个 import SDK 的扩展都加载失败而其余一切
 * 照常。两种已发生的坏法：别名高了两层（sdkModuleUrlPlugin 修复）、
 * 磁盘 SDK 缺自己的依赖（scripts/check_extension_runtime.mjs）。
 */
export async function runExtensionSdkImportTest(cwd: string): Promise<DiagnosticResult[]> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-sdk-import-"));
    const probeDir = dir;
    await writeFile(join(probeDir, "index.ts"), SDK_IMPORT_PROBE_EXTENSION, "utf8");
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { additionalExtensionPaths: [probeDir] },
    });
    const { extensions, errors } = services.resourceLoader.getExtensions();
    const probe = extensions.find((extension) => extension.path.startsWith(probeDir));
    const failure = errors.find((error) => String((error as { path?: string }).path ?? "").startsWith(probeDir));
    return [{
      name: "extension sdk import",
      ok: probe !== undefined && failure === undefined,
      detail: failure
        ? `probe extension failed to load: ${String((failure as { error?: unknown }).error ?? failure)}`
        : `probe extension loaded, tools: ${probe ? [...probe.tools.keys()].join(", ") || "(none)" : "(not found)"}`,
    }];
  } catch (error) {
    return [{ name: "extension sdk import", ok: false, detail: describe(error) }];
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 同一个 pi 扩展的两个版本，证明 reload 换掉了实例。 */
const reloadProbeExtension = (toolName: string) => `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "${toolName}",
    label: "Reload probe",
    description: "diagnostic probe",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "probe" }], details: {} }),
  });
}
`;

/**
 * 重载资源必须重建会话的扩展 runner。会话的 ExtensionRunner 从 loader
 * 缓存的 getExtensions() 只建一次，只重载 resource loader 会让会话留在
 * 旧实例上、重载出的那套闲置——之后的 bindExtensions() 也只是向旧实例
 * 重发 session_start。AgentSession.reload() 是 SDK 全体的答案（三个
 * mode 的 /reload 都是它）。本检查在两次读取之间改写探针扩展：新工具
 * 要出现、旧工具要消失，宿主 customTools 与 pi 核心工具都不得掉出
 * 重建后的注册表。
 */
export async function runExtensionReloadTest(cwd: string): Promise<DiagnosticResult[]> {
  const coordinator = new SubagentCoordinator(() => {});
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-reload-"));
    const entry = join(dir, "index.ts");
    await writeFile(entry, reloadProbeExtension("reload_probe_before"), "utf8");
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { additionalExtensionPaths: [dir] },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      customTools: [coordinator.createTool({ enabled: true, maxSubagents: 3 })],
    });
    // 按侧栏的方式绑定扩展：不绑定的话 reload() 会跳过 session_start，探针证明的就比看上去少。
    await session.bindExtensions({ mode: "rpc", onError: () => {} });
    const before = session.agent.state.tools.map((tool) => tool.name);

    await writeFile(entry, reloadProbeExtension("reload_probe_after"), "utf8");
    await session.reload();
    const after = session.agent.state.tools.map((tool) => tool.name);
    session.dispose();
    await coordinator.dispose();

    /* 重载前就在、只是被刻意改写掉的探针工具以外的全部工具。在此点名
       pi 的工具反而会让 defaultTools 不同于默认集的用户看到红——那是
       配置选择，不是缺陷。 */
    const dropped = before.filter((name) => name !== "reload_probe_before" && !after.includes(name));
    const ok = before.includes("reload_probe_before") &&
      after.includes("reload_probe_after") &&
      !after.includes("reload_probe_before") &&
      dropped.length === 0;
    return [{
      name: "extension reload",
      ok,
      detail: `loaded=${before.includes("reload_probe_before")}; after reload: new=${after.includes("reload_probe_after")}, stale=${after.includes("reload_probe_before")}, dropped=${dropped.join(", ") || "(none)"}`,
    }];
  } catch (error) {
    await coordinator.dispose();
    return [{ name: "extension reload", ok: false, detail: describe(error) }];
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 扩展*命令* handler 必须能驱动会话。ctx.newSession() / fork() /
 * switchSession() / navigateTree() / reload() 由宿主提供的 actions 支撑
 * （bindExtensions({ commandContextActions })）；不接则 SDK 退化为报告
 * 成功的 no-op stub，扩展命令看起来生效、实际什么都没改。本检查按扩展
 * 的方式驱动真实命令上下文：会话要真的被替换，且侧栏恰好被告知一次
 * reattach——替换发生在 SDK 内部，只有 rebind 钩子能通知它。
 */
export async function runExtensionCommandContextTest(cwd: string): Promise<DiagnosticResult[]> {
  let runtime: PiRuntime | undefined;
  try {
    runtime = await PiRuntime.create({ cwd, log: () => {} });
    let reattached = 0;
    runtime.setSessionLifecycleSink({
      reattach: async () => {
        reattached += 1;
      },
      reload: async () => {},
    });
    await runtime.bindExtensions();

    const before = runtime.session.sessionId;
    const context = runtime.session.extensionRunner.createCommandContext();
    const result = await context.newSession();
    const replaced = !result.cancelled && runtime.session.sessionId !== before;
    return [{
      name: "extension command context",
      ok: replaced && reattached === 1,
      detail: `ctx.newSession(): replaced=${replaced}, reattach calls=${reattached}`,
    }];
  } catch (error) {
    return [{ name: "extension command context", ok: false, detail: describe(error) }];
  } finally {
    runtime?.dispose();
  }
}
