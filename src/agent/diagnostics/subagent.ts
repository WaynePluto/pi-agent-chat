/** `subagent` 工具的自检：开关两态、同名屏蔽、scope、模型选择、隔离。 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe } from "../errors.js";
import { createSubagentServices, findShadowedExtensionTool } from "../runtime.js";
import { findScopeConflict, normalizeScopes, ScopeGuard } from "../scope.js";
import { createScopedFileTools } from "../scoped-tools.js";
import { SubagentCoordinator, SUBAGENT_TOOL, planModel } from "../subagent.js";
import type { DiagnosticResult } from "../diagnostics.js";

/**
 * 关于本扩展给 pi 工具集添的唯一一个工具的离线检查：开启时它必须已注册
 * 并激活而无需任何显式激活调用、不得漏进子会话、不得挤掉 pi 的核心
 * 工具；关闭时必须彻底缺席。基线取本窗口不带宿主工具时的激活集——那是
 * 唯一诚实的基线：pi 哪些工具开着是用户的决定（共享设置 defaultTools、
 * 扩展可再激活更多），在此点名会让配置选择报红，而默认就红的自检
 * 没有人看。
 */
export async function runSubagentToolTest(cwd: string): Promise<DiagnosticResult[]> {
  const coordinator = new SubagentCoordinator(() => {});
  const tool = coordinator.createTool({ enabled: true, maxSubagents: 3 });
  try {
    const baselineResult = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(cwd),
    });
    const baselineActive = new Set(baselineResult.session.getActiveToolNames());
    baselineResult.session.dispose();

    const parentResult = await createAgentSession({
      cwd,
      customTools: [tool],
      /* 镜像 runtime.ts 的真实装配：开启时不排除——SDK 工具注册表让 custom
         tool 覆盖同名扩展工具（core/agent-session.ts 的 _refreshToolRegistry）。
         子会话拿带 scope 的文件工具而非内置那对，且永远够不到委派工具
         本身。默认关闭 = 名字干脆不存在：走排除集，因为没有宿主工具去
         接管这个名字。加自定义工具不得挤掉任何原本激活的。 */
      sessionManager: SessionManager.inMemory(cwd),
    });
    const parentActive = new Set(parentResult.session.getActiveToolNames());
    parentResult.session.dispose();

    const childResult = await createAgentSession({
      cwd,
      customTools: [tool],
      excludeTools: [SUBAGENT_TOOL],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const childHasTool = childResult.session.agent.state.tools.some((entry) => entry.name === SUBAGENT_TOOL);
    childResult.session.dispose();

    const offResult = await createAgentSession({
      cwd,
      customTools: [],
      excludeTools: [SUBAGENT_TOOL],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const offActive = new Set(offResult.session.getActiveToolNames());
    offResult.session.dispose();
    await coordinator.dispose();

    const displaced = [...baselineActive].filter((name) => !parentActive.has(name));
    return [{
      name: "subagent tool",
      ok:
        parentActive.has(SUBAGENT_TOOL) &&
        !childHasTool &&
        !offActive.has(SUBAGENT_TOOL) &&
        displaced.length === 0,
      detail: `active: ${[...parentActive].sort().join(", ") || "(none)"}; child=${childHasTool ? "unexpectedly enabled" : "excluded"}; disabled=${offActive.has(SUBAGENT_TOOL) ? "still present" : "absent"}; displaced=${displaced.join(", ") || "(none)"}`,
    }, ...(await checkSubagentShadow(cwd, tool)), ...(await checkScopeEnforcement(cwd)), checkSubagentModelSelection(), ...(await checkSubagentIsolation(cwd))];
  } catch (error) {
    await coordinator.dispose();
    return [{ name: "subagent tool", ok: false, detail: describe(error) }];
  }
}

/** 一个占用 `subagent` 工具名的 pi 扩展，写入临时目录。 */
const SUBAGENT_PROBE_EXTENSION = `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "diagnostic probe",
    parameters: Type.Object({ task: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: "probe" }], details: {} }),
  });
}
`;

/**
 * 扩展的 `subagent` 工具绝不能到达本宿主的模型。名字归插件所有，两个
 * 开关态都成立：关闭时名字被排除；开启时 SDK 工具注册表让 custom tool
 * 覆盖同名扩展工具（_refreshToolRegistry），模型解析 `subagent` 永远拿到
 * 宿主的工具或什么都没有。被屏蔽的扩展仍可识别（新会话提示要点名它）；
 * 开启态靠 description 内容认出是宿主的工具。覆盖还必须挺过 reload：
 * reload() 从持久排除集与 custom tools 重建注册表并重激活全部扩展工具，
 * 没真被覆盖的名字会当场浮出来。
 */
async function checkSubagentShadow(cwd: string, tool: ToolDefinition): Promise<DiagnosticResult[]> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-subagent-ext-"));
    await writeFile(join(dir, "index.ts"), SUBAGENT_PROBE_EXTENSION, "utf8");
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { additionalExtensionPaths: [dir] },
    });
    const shadowed = findShadowedExtensionTool(services, SUBAGENT_TOOL);

    const off = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      excludeTools: [SUBAGENT_TOOL],
    });
    const offClean = !off.session.getActiveToolNames().includes(SUBAGENT_TOOL);
    off.session.dispose();

    const on = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      customTools: [tool],
    });
    const onOurs = isHostSubagentTool(on.session);
    await on.session.reload();
    const reloadOurs = isHostSubagentTool(on.session);
    on.session.dispose();

    return [{
      name: "subagent shadowing",
      ok: shadowed === dir && offClean && onOurs && reloadOurs,
      detail:
        `detected=${shadowed ?? "(none)"}; off=${offClean ? "absent" : "LEAKED"}; ` +
        `on=${onOurs ? "host tool wins" : "EXTENSION TOOL EXPOSED"}; ` +
        `after reload=${reloadOurs ? "host tool wins" : "EXTENSION TOOL EXPOSED"}`,
    }];
  } catch (error) {
    return [{ name: "subagent shadowing", ok: false, detail: describe(error) }];
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function isHostSubagentTool(session: AgentSession): boolean {
  const info = session.getAllTools().find((entry) => entry.name === SUBAGENT_TOOL);
  return info?.description?.includes("isolated subagents") ?? false;
}

/**
 * 子代理在其声明的范围之外的写入必须被拒。这是整个功能的立身之本：
 * 子代理直接写真工作区、失败不回滚，仅作说明的范围会让设计站不住。
 * 走真实的强制路径——用替换了文件操作层的 SDK 自家 edit/write 定义——
 * 而非孤立的检查器。被拒的路径本身也要进得了汇报：光有计数，父代理
 * 无从接手子代理没做完的事。
 */
async function checkScopeEnforcement(cwd: string): Promise<DiagnosticResult[]> {
  try {
    const guard = new ScopeGuard(cwd, normalizeScopes(cwd, ["src"]));
    const names = createScopedFileTools(cwd, guard).map((tool) => tool.name).sort();

    let refused = false;
    try {
      guard.assertWritable(join(cwd, "package.json"));
    } catch {
      refused = true;
    }
    let allowed = true;
    try {
      guard.recordWrite(join(cwd, "src", "probe.ts"));
    } catch {
      allowed = false;
    }
    // 一个范围包含另一个时两路可能写同一个文件，必须在任何子代理启动前拒绝。
    const conflict = findScopeConflict([normalizeScopes(cwd, ["src"]), normalizeScopes(cwd, ["src/agent"])]);
    const disjoint = findScopeConflict([normalizeScopes(cwd, ["src/agent"]), normalizeScopes(cwd, ["src/webview"])]);

    return [{
      name: "subagent scope enforcement",
      ok:
        names.join(",") === "edit,write" &&
        refused &&
        allowed &&
        Boolean(conflict) &&
        !disjoint &&
        guard.writtenFiles.join(",") === "src/probe.ts" &&
        guard.violationCount === 1 &&
        guard.deniedPaths.join(",") === "package.json",
      detail: `tools=${names.join(",")}; out-of-range=${refused ? "refused" : "ALLOWED"}; in-range=${allowed ? "allowed" : "REFUSED"}; denied=${guard.deniedPaths.join(",") || "NONE"}; overlap=${conflict ? "rejected" : "MISSED"}; disjoint=${disjoint ? "WRONGLY REJECTED" : "accepted"}`,
    }];
  } catch (error) {
    return [{ name: "subagent scope enforcement", ok: false, detail: describe(error) }];
  }
}

/**
 * 子代理的模型从哪来、缺了告诉谁。主代理自己指名的模型缺失是机械的
 * 参数错误：必须在任何一路启动前拒绝，它才能自我修正。用户配置的那级
 * （子代理默认模型）缺失则降级到下一来源、只提示用户：为一个笔误废掉
 * 整路任务代价太大，报给父代理则是让它「修正」自己没发过的参数。
 * 三种情形：设置命中→静默用之；未命中→继承父模型并提示用户；未配置→
 * 父模型、无提示。
 */
function checkSubagentModelSelection(): DiagnosticResult {
  type Options = Parameters<typeof planModel>[0];
  try {
    const known = [{ provider: "acme", id: "fast" }, { provider: "acme", id: "slow" }];
    const modelRuntime = {
      getModel: (provider: string, id: string) => known.find((model) => model.provider === provider && model.id === id),
      getModels: () => known,
    } as unknown as Options["modelRuntime"];
    const parentModel = known[1] as Options["parentModel"];
    const base = { modelRuntime, parentModel, index: 0 };
    const enabled = { enabled: true, maxSubagents: 3 };

    let requestedRejected = false;
    try {
      planModel({ ...base, requested: "acme/missing", config: enabled });
    } catch {
      requestedRejected = true;
    }

    const settingOk = planModel({ ...base, config: { ...enabled, defaultModel: "acme/fast" } });
    const settingMiss = planModel({ ...base, config: { ...enabled, defaultModel: "acme/gone" } });
    const inherited = planModel({ ...base, config: enabled });

    const ok =
      requestedRejected &&
      settingOk.model?.id === "fast" &&
      settingOk.notices.length === 0 &&
      settingMiss.model?.id === "slow" &&
      settingMiss.notices.length === 1 &&
      settingMiss.notices[0]?.source === "setting" &&
      settingMiss.notices[0]?.using === "acme/slow" &&
      inherited.model?.id === "slow" &&
      inherited.notices.length === 0;
    return {
      name: "subagent model selection",
      ok,
      detail:
        `requested-miss=${requestedRejected ? "rejected" : "ACCEPTED"}; ` +
        `setting-ok=${settingOk.model?.id ?? "none"}/${settingOk.notices.length} notice(s); ` +
        `setting-miss=${settingMiss.model?.id ?? "none"}/${settingMiss.notices.length} notice(s); ` +
        `inherited=${inherited.model?.id ?? "none"}/${inherited.notices.length} notice(s)`,
    };
  } catch (error) {
    return { name: "subagent model selection", ok: false, detail: describe(error) };
  }
}

/** 一个经共享 `pi` API 读会话状态的 pi 扩展。 */
const SESSION_NAME_PROBE_EXTENSION = `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "session_name_probe",
    label: "Session name probe",
    description: "diagnostic probe",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: pi.getSessionName() ?? "(unnamed)" }],
      details: {},
    }),
  });
}
`;

/**
 * 结束的子代理必须不碰父会话的扩展。扩展按 resource loader 加载一次、
 * 该 loader 建的每个会话共享同一扩展 runtime：用父会话的 services 建子
 * 会话会把所有 pi.* 劫持到子会话身上，dispose() 再把共享 runtime 永久
 * 标 stale。本检查跑 coordinator 的真实 service 构造（createSubagentServices()），
 * 销毁子会话后回调父会话的扩展 API：必须还能答，且答出*父*会话的名字。
 * 探针走包装后的 agent tool 而非 getToolDefinition()——后者交回的是仍
 * 期待 ExtensionContext 的原始定义。
 */
async function checkSubagentIsolation(cwd: string): Promise<DiagnosticResult[]> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-subagent-iso-"));
    await writeFile(join(dir, "index.ts"), SESSION_NAME_PROBE_EXTENSION, "utf8");
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { additionalExtensionPaths: [dir] },
    });
    const { session: parent } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
    });
    parent.setSessionName("parent");

    const childServices = await createSubagentServices(services);
    const { session: child } = await createAgentSessionFromServices({
      services: childServices,
      sessionManager: SessionManager.inMemory(cwd),
      excludeTools: ["subagent"],
    });
    child.setSessionName("child");
    child.dispose();

    const probe = parent.agent.state.tools.find((tool) => tool.name === "session_name_probe");
    let answer: string;
    try {
      const result = await probe?.execute("probe", {}, undefined, undefined);
      const block = result?.content.find((entry) => entry.type === "text");
      answer = block && "text" in block ? block.text : "(no probe tool)";
    } catch (error) {
      answer = `threw: ${describe(error)}`;
    }
    parent.dispose();
    return [{
      name: "subagent isolation",
      ok: answer === "parent",
      detail: `parent extension API after child dispose: ${answer}`,
    }];
  } catch (error) {
    return [{ name: "subagent isolation", ok: false, detail: describe(error) }];
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
