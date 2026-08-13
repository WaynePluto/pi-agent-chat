import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, createAgentSessionFromServices, createAgentSessionServices, getAgentDir, getPackageDir, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { buildHistoryEntryEvents, ChatBridge, collectResourceSections } from "./bridge.js";
import { collectSlashCommands } from "./commands.js";
import { OriginalContentProvider } from "./diff-view.js";
import { describe } from "./errors.js";
import { createSubagentServices, findShadowedSubagentExtension, PiRuntime } from "./runtime.js";
import { buildTreeChoices } from "./session-tree.js";
import { ParallelSubagentCoordinator, PARALLEL_SUBAGENT_TOOL, planModel, type LaneState, type ParallelRun } from "./parallel-subagent.js";
import { findScopeConflict, normalizeScopes, ScopeGuard } from "./scope.js";
import { createScopedFileTools } from "./scoped-tools.js";
import { ProjectFileIndex } from "./project-files.js";
import type { ChatState, HostMessage } from "../shared/protocol.js";

/** Injected by esbuild (see esbuild.mjs). */
declare const __PI_UNDICI_VERSION__: string;
declare const __PI_SDK_VERSION__: string;

export interface DiagnosticResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Spike risk checks from `vscode-pi-design.md` §3 and §8:
 * native module load, jiti `.ts` extension loading, and the undici alias.
 */
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

/** The bundle must contain exactly one undici, at >= 8.7.0 (proxy fix). */
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

/** Bundling can break path lookups that assume the SDK's on-disk layout. */
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

/** Extensions authored in TypeScript are loaded through jiti at runtime. */
async function checkJiti(): Promise<DiagnosticResult> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-jiti-"));
    const file = join(dir, "probe.ts");
    await writeFile(file, "const value: number = 42;\nexport default value;\n", "utf8");
    const { createJiti } = await import("jiti/static");
    // `__filename` exists because the extension bundle is emitted as CJS.
    const jiti = createJiti(__filename);
    const loaded = (await jiti.import(file, { default: true })) as number;
    return { name: "jiti .ts loading", ok: loaded === 42, detail: `loaded probe.ts -> ${String(loaded)}` };
  } catch (error) {
    return { name: "jiti .ts loading", ok: false, detail: describe(error) };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Optional native dependency used for image paste; must degrade gracefully. */
async function checkClipboardNative(): Promise<DiagnosticResult> {
  try {
    const mod = await import("@mariozechner/clipboard");
    return { name: "native clipboard (optional)", ok: true, detail: `loaded, exports: ${Object.keys(mod).join(", ") || "(none)"}` };
  } catch (error) {
    return { name: "native clipboard (optional)", ok: false, detail: `not loadable (image paste disabled): ${describe(error)}` };
  }
}

export function formatDiagnostics(results: DiagnosticResult[]): string {
  const lines = ["# Pi Agent Chat - Spike Diagnostics", ""];
  for (const result of results) {
    lines.push(`${result.ok ? "[ok]  " : "[fail]"} ${result.name}: ${result.detail}`);
  }
  return lines.join("\n");
}

/**
 * Offline check (no LLM call): resume the most recent session for `cwd` and
 * verify the persisted transcript maps to renderable chat events.
 */
export async function runHistoryReplayTest(cwd: string): Promise<DiagnosticResult[]> {
  try {
    const sessions = await SessionManager.list(cwd);
    if (sessions.length === 0) {
      return [{ name: "history replay", ok: true, detail: "no saved sessions for this cwd (nothing to replay)" }];
    }
    const { session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.open(sessions[0]!.path),
    });
    const contextMessageCount = session.messages.length;
    const branchEntries = session.sessionManager.getBranch();
    const events = buildHistoryEntryEvents(branchEntries, cwd);
    session.dispose();
    const counts = events.reduce<Record<string, number>>((acc, event) => {
      acc[event.kind] = (acc[event.kind] ?? 0) + 1;
      return acc;
    }, {});
    return [
      {
        name: "history replay",
        ok: events.length > 0,
        detail: `${sessions.length} session(s); newest -> ${branchEntries.length} branch entries, ${contextMessageCount} context messages, ${events.length} events (${
          Object.entries(counts)
            .map(([kind, count]) => `${kind}:${count}`)
            .join(", ") || "none"
        })`,
      },
    ];
  } catch (error) {
    return [{ name: "history replay", ok: false, detail: describe(error) }];
  }
}

/**
 * Offline check (no LLM call): the `/` autocomplete catalogue must contain the
 * built-ins plus everything the CLI would offer (prompts, extension commands,
 * skills).
 */
export async function runSlashCommandTest(cwd: string): Promise<DiagnosticResult[]> {
  try {
    const { session } = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd) });
    const commands = collectSlashCommands(session);
    session.dispose();
    const counts = commands.reduce<Record<string, number>>((acc, command) => {
      acc[command.kind] = (acc[command.kind] ?? 0) + 1;
      return acc;
    }, {});
    return [
      {
        name: "slash commands",
        ok: (counts.builtin ?? 0) > 0,
        detail: `${commands.length} total (${Object.entries(counts)
          .map(([kind, count]) => `${kind}:${count}`)
          .join(", ")})`,
      },
    ];
  } catch (error) {
    return [{ name: "slash commands", ok: false, detail: describe(error) }];
  }
}

/**
 * Offline check (no LLM call): the session tree of the most recent session must
 * flatten into selectable entries, which is what `/tree` and `/fork` show.
 */
export async function runSessionTreeTest(cwd: string): Promise<DiagnosticResult[]> {
  try {
    const sessions = await SessionManager.list(cwd);
    if (sessions.length === 0) {
      return [{ name: "session tree", ok: true, detail: "no saved sessions for this cwd (nothing to navigate)" }];
    }
    const sessionManager = SessionManager.open(sessions[0]!.path);
    const all = buildTreeChoices(sessionManager);
    const userOnly = buildTreeChoices(sessionManager, { userMessagesOnly: true });
    const leafId = sessionManager.getLeafEntry()?.id;
    return [
      {
        name: "session tree",
        ok: all.length > 0 && all.length >= userOnly.length,
        detail: `${all.length} navigable entries, ${userOnly.length} fork points, leaf=${leafId ?? "(none)"}`,
      },
    ];
  } catch (error) {
    return [{ name: "session tree", ok: false, detail: describe(error) }];
  }
}

/** Offline check: project file discovery, filtering and path validation for the @ picker. */
export async function runProjectFilesTest(cwd: string): Promise<DiagnosticResult[]> {
  try {
    const index = new ProjectFileIndex(() => {});
    const items = await index.search(cwd, "", false);
    const hasFiles = items.length > 0;

    // Path safety: escaping / absolute paths must be rejected.
    let escapeRejected = false;
    try {
      await index.validate(cwd, ["../outside.txt"]);
    } catch {
      escapeRejected = true;
    }

    // A known real file must validate cleanly.
    const sample = items[0]?.path;
    const validated = sample ? await index.validate(cwd, [sample]) : { paths: [] };
    const sampleOk = !sample || validated.paths.length === 1;

    return [{
      name: "project files",
      ok: hasFiles && escapeRejected && sampleOk,
      detail: `indexed=${items.length}, escapeRejected=${escapeRejected}, sample=${sample ?? "n/a"}`,
    }];
  } catch (error) {
    return [{ name: "project files", ok: false, detail: describe(error) }];
  }
}

/**
 * Offline check on the one tool this extension adds to pi's own set: when
 * enabled it must be registered and active without any explicit activation
 * call, it must not leak into a child session, and it must not displace pi's
 * core tools. When disabled it must be absent entirely.
 */
export async function runSubagentToolTest(cwd: string): Promise<DiagnosticResult[]> {
  const coordinator = new ParallelSubagentCoordinator(() => {});
  const tool = coordinator.createTool({ enabled: true, maxParallel: 3 });
  try {
    const parentResult = await createAgentSession({
      cwd,
      customTools: [tool],
      // Mirror the real assembly in `runtime.ts`: the extension-registered
      // `subagent` is dropped unconditionally, so a check that omitted this
      // would report the shadowed tool as active and stop guarding the rule.
      excludeTools: ["subagent"],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const parentActive = new Set(parentResult.session.getActiveToolNames());
    parentResult.session.dispose();

    // A child gets scoped file tools instead of the built-in ones, and can
    // never reach the delegation tool itself.
    const childResult = await createAgentSession({
      cwd,
      customTools: [tool],
      excludeTools: [PARALLEL_SUBAGENT_TOOL, "subagent"],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const childHasTool = childResult.session.agent.state.tools.some((entry) => entry.name === PARALLEL_SUBAGENT_TOOL);
    childResult.session.dispose();

    // Disabled is the default, and must mean the name is simply not there.
    const offResult = await createAgentSession({
      cwd,
      customTools: [],
      excludeTools: ["subagent"],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const offActive = new Set(offResult.session.getActiveToolNames());
    offResult.session.dispose();
    await coordinator.dispose();

    const missingCore = ["read", "bash", "edit", "write"].filter((name) => !parentActive.has(name));
    // Neither state may ever expose a `subagent`: off means no delegation tool
    // at all, on means exactly one, and never the one that fails silently here.
    const shadowLeaked = parentActive.has("subagent") || offActive.has("subagent");
    return [{
      name: "parallel subagent tool",
      ok:
        parentActive.has(PARALLEL_SUBAGENT_TOOL) &&
        !childHasTool &&
        !offActive.has(PARALLEL_SUBAGENT_TOOL) &&
        !shadowLeaked &&
        missingCore.length === 0,
      detail: `active: ${[...parentActive].sort().join(", ") || "(none)"}; child=${childHasTool ? "unexpectedly enabled" : "excluded"}; disabled=${offActive.has(PARALLEL_SUBAGENT_TOOL) ? "still present" : "absent"}; subagent=${shadowLeaked ? "LEAKED" : "shadowed"}`,
    }, ...(await checkSubagentShadow(cwd)), ...(await checkScopeEnforcement(cwd)), checkSubagentModelSelection(), ...(await checkSubagentIsolation(cwd))];
  } catch (error) {
    await coordinator.dispose();
    return [{ name: "parallel subagent tool", ok: false, detail: describe(error) }];
  }
}

/** A pi extension that claims the `subagent` tool name, written to a temp dir. */
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
 * An extension's `subagent` tool must never reach the model in this host.
 *
 * It cannot work here: such an extension re-launches pi and locates it by
 * introspecting its own process, which inside the extension host points at VS
 * Code's own bootstrap — the spawn then exits 0 with no output and the model
 * reasons on an empty result. Suppression is unconditional, independent of
 * whether this window's own delegation tool is enabled, so the user is never
 * offered a broken tool.
 *
 * Pins both halves: the tool really is gone from the session, and the
 * suppressed extension is still identifiable so the new-session notice can name
 * it. Also pins the timing detection relies on — extension tool names are
 * readable straight after `createAgentSessionServices()`.
 */
async function checkSubagentShadow(cwd: string): Promise<DiagnosticResult[]> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-subagent-ext-"));
    await writeFile(join(dir, "index.ts"), SUBAGENT_PROBE_EXTENSION, "utf8");
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { additionalExtensionPaths: [dir] },
    });
    const shadowed = findShadowedSubagentExtension(services);
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      // Exactly what `PiRuntime.create()` does: always exclude.
      excludeTools: ["subagent"],
    });
    const stillThere = session.getActiveToolNames().includes("subagent");
    session.dispose();
    return [{
      name: "subagent suppression",
      ok: shadowed === dir && !stillThere,
      detail: `detected=${shadowed ?? "(none)"}; tool=${stillThere ? "STILL ACTIVE" : "suppressed"}`,
    }];
  } catch (error) {
    return [{ name: "subagent suppression", ok: false, detail: describe(error) }];
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * A subagent's writes must be refused outside its declared range.
 *
 * This is the guarantee the whole feature rests on: children write to the real
 * working tree and nothing is rolled back, so a range that is merely advisory
 * would make the design indefensible. Exercises the actual enforcement path —
 * the SDK's own `edit`/`write` definitions built with a replacement file
 * operation layer — rather than the checker in isolation.
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
    // Two ranges where one contains the other could target the same file, so
    // the call must be rejected before any child starts.
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
        // The refused path itself must survive to the report: a bare count
        // leaves the parent unable to finish what the child could not.
        guard.deniedPaths.join(",") === "package.json",
      detail: `tools=${names.join(",")}; out-of-range=${refused ? "refused" : "ALLOWED"}; in-range=${allowed ? "allowed" : "REFUSED"}; denied=${guard.deniedPaths.join(",") || "NONE"}; overlap=${conflict ? "rejected" : "MISSED"}; disjoint=${disjoint ? "WRONGLY REJECTED" : "accepted"}`,
    }];
  } catch (error) {
    return [{ name: "subagent scope enforcement", ok: false, detail: describe(error) }];
  }
}

/**
 * Where a subagent's model comes from, and who is told when one is missing.
 *
 * A model the parent agent named itself is a mechanical argument error: the
 * call must be rejected before any child starts, so it can correct it. A model
 * the *user* configured — the subagent default model setting — must
 * step down to the next source instead and produce a user-facing notice only:
 * failing the lane would throw away a whole task over a typo, and reporting it
 * to the parent would describe a choice it never made.
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
    const enabled = { enabled: true, maxParallel: 3 };

    let requestedRejected = false;
    try {
      planModel({ ...base, requested: "acme/missing", config: enabled });
    } catch {
      requestedRejected = true;
    }

    // The setting resolves: the lane runs on it, silently.
    const settingOk = planModel({ ...base, config: { ...enabled, defaultModel: "acme/fast" } });
    // The setting misses: the lane inherits the parent's model and the user
    // (not the parent agent) is told.
    const settingMiss = planModel({ ...base, config: { ...enabled, defaultModel: "acme/gone" } });
    // Nothing configured: the parent's model, no notice.
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

/** A pi extension whose tool reads session state through the shared `pi` API. */
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
 * A finished subagent must leave the parent's extensions alone.
 *
 * Extensions are loaded per resource loader and every session built from that
 * loader shares the resulting extension runtime, so a child session created
 * from the parent's services would retarget every `pi.*` action at itself and
 * then mark the shared runtime stale on `dispose()`. This runs the coordinator's
 * exact service construction (`createSubagentServices()`), disposes the child,
 * and calls back into the parent's extension API: it must still answer, and it
 * must answer with the *parent's* session name.
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

    // The wrapped agent tool, not `getToolDefinition()`: the latter hands back
    // the raw extension definition, which still expects an ExtensionContext.
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

/** A pi extension that imports the SDK the way real extensions do. */
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
 * An extension must be able to `import "@earendil-works/pi-coding-agent"`.
 *
 * Only meaningful inside the bundle. Extensions are loaded by jiti against the
 * SDK *on disk*, using aliases the SDK derives from `import.meta.url` — which
 * bundling to CJS erases and `esbuild.mjs` has to reconstruct. Get that wrong
 * and the alias points at a path that does not exist, so every extension
 * importing the SDK fails to load while everything else keeps working.
 *
 * Two ways this has already broken: the alias landing two directories too high
 * (fixed by `sdkModuleUrlPlugin`), and the on-disk SDK missing its own
 * dependencies (`scripts/check_extension_runtime.mjs`).
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

/** One pi extension in two versions, to prove a reload swaps the instances. */
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
 * Reloading resources must rebuild the session's extension runner.
 *
 * A session builds its `ExtensionRunner` once, from the loader's cached
 * `getExtensions()`, so reloading the resource loader alone leaves the session
 * on the *old* extension instances while the reloaded set sits unused — and a
 * `bindExtensions()` after it only re-fires `session_start` into those old
 * instances. `AgentSession.reload()` is the SDK-wide answer (all three modes
 * call it). This rewrites a probe extension between the two reads: the new
 * tool must appear, the old one must be gone, and neither the host's
 * `customTools` nor pi's core tools may fall out of the rebuilt registry.
 */
export async function runExtensionReloadTest(cwd: string): Promise<DiagnosticResult[]> {
  const coordinator = new ParallelSubagentCoordinator(() => {});
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
      customTools: [coordinator.createTool({ enabled: true, maxParallel: 3 })],
    });
    // Bindings of the same shape the sidebar attaches: without any, reload()
    // skips session_start and the probe would prove less than it looks.
    await session.bindExtensions({ mode: "rpc", onError: () => {} });
    const before = session.agent.state.tools.map((tool) => tool.name);

    await writeFile(entry, reloadProbeExtension("reload_probe_after"), "utf8");
    await session.reload();
    const after = session.agent.state.tools.map((tool) => tool.name);
    session.dispose();
    await coordinator.dispose();

    const dropped = ["read", "bash", "edit", "write", PARALLEL_SUBAGENT_TOOL].filter((name) => !after.includes(name));
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
 * Extension *command* handlers must be able to drive the session.
 *
 * `ctx.newSession()` / `ctx.fork()` / `ctx.switchSession()` /
 * `ctx.navigateTree()` / `ctx.reload()` are backed by host-supplied actions
 * (`bindExtensions({ commandContextActions })`); without them the SDK falls
 * back to no-op stubs that report success, so an extension command would
 * appear to work and change nothing. This drives a real command context the
 * way an extension would: the session must actually be replaced, and the
 * sidebar must be told to re-attach (only the rebind hook can tell it — the
 * replacement happened inside the SDK).
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

/**
 * The view state machine, driven through the real webview entry points.
 *
 * Exists because of a bug that survived three rounds of fixes: what the webview
 * shows used to be three independent fields, and each fix updated some of them.
 * The last one was `postState()` discarding the delegation whenever a preview
 * was open, which silently undid the framing computed just above it.
 *
 * The point here is that nothing is hand-assembled: this drives
 * `handleMessage()` and reads what `postState()` actually posted. A test that
 * built `ChatState` itself — as the webview smoke script necessarily does —
 * cannot see a bug in the code that builds it.
 */
export async function runViewStateTest(cwd: string): Promise<DiagnosticResult[]> {
  const posted: HostMessage[] = [];
  const lastState = (): ChatState | undefined => {
    for (let i = posted.length - 1; i >= 0; i -= 1) {
      const message = posted[i];
      if (message?.type === "state") return message.state;
    }
    return undefined;
  };
  const lastTranscriptId = (): string | undefined => {
    for (let i = posted.length - 1; i >= 0; i -= 1) {
      const message = posted[i];
      if (message?.type === "history") return message.transcriptId;
    }
    return undefined;
  };

  let runtime: PiRuntime | undefined;
  let child: AgentSession | undefined;
  try {
    runtime = await PiRuntime.create({ cwd, log: () => {} });
    const bridge = new ChatBridge(
      runtime,
      { post: (message) => posted.push(message), log: () => {} },
      new OriginalContentProvider(),
    );
    await bridge.attach();
    const parentTranscript = lastTranscriptId();

    const failures: string[] = [];
    const expect = (label: string, ok: boolean) => {
      if (!ok) failures.push(label);
    };

    // Live: the parent is writable and is not "inside" anything.
    const live = lastState();
    expect("live: input enabled", live?.inputDisabled !== true);
    expect("live: not in a lane", live?.delegation?.role !== "child");

    // A lane with a live child session: the transcript switches to the child,
    // input is closed, and the banner has a lane to name.
    const childResult = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd) });
    child = childResult.session;
    const lane: LaneState = {
      id: "lane-probe",
      title: "probe",
      task: "probe task",
      scope: [],
      status: "running",
      writtenFiles: [],
      scopeViolations: 0,
      deniedPaths: [],
      bashMayHaveWritten: false,
      startedAt: Date.now(),
      sessionId: child.sessionId,
      sessionFile: child.sessionFile,
    };
    const run: ParallelRun = { id: "run-probe", parent: runtime.session, lanes: [lane], startedAt: Date.now() };
    bridge.onRunStarted(run);
    bridge.onLaneStarted(run, lane, child);
    await bridge.handleMessage({ type: "showLane", laneId: lane.id });
    const inLane = lastState();
    expect("lane: role is child", inLane?.delegation?.role === "child");
    expect("lane: names the lane", inLane?.delegation?.currentLaneId === lane.id);
    expect("lane: read-only", inLane?.inputDisabled === true);
    expect("lane: own transcript", lastTranscriptId() === child.sessionId);

    // Back to the parent, by the same route the banner's button uses.
    await bridge.handleMessage({ type: "showLane" });
    const back = lastState();
    expect("back: role is parent", back?.delegation?.role === "parent");
    expect("back: writable again", back?.inputDisabled !== true);
    expect("back: parent transcript", lastTranscriptId() === parentTranscript);

    // The regression that took three rounds: a subagent whose live session is
    // gone is shown by replaying its file, and *both* flags must be set. A
    // preview without the delegation renders "back to the running session".
    const sessions = await SessionManager.list(cwd);
    const other = sessions.find((info) => info.path !== runtime?.session.sessionFile);
    let replayDetail = "skipped (no other session on disk)";
    if (other) {
      await bridge.handleMessage({ type: "showLane", laneId: "gone", sessionFile: other.path, title: "Node version" });
      const replayed = lastState();
      expect("replayed lane: is a preview", replayed?.preview?.file === other.path);
      expect("replayed lane: still a subagent", replayed?.delegation?.role === "child");
      expect("replayed lane: read-only", replayed?.inputDisabled === true);
      expect("replayed lane: transcript is the file", lastTranscriptId() === other.path);

      // An ordinary preview must NOT claim to be a subagent, or every session
      // opened during a run would grow a bogus "back to the parent" banner.
      await bridge.handleMessage({ type: "closePreview" });
      await bridge.handleMessage({ type: "previewSession", file: other.path });
      const plain = lastState();
      expect("plain preview: is a preview", plain?.preview?.file === other.path);
      expect("plain preview: not a subagent", plain?.delegation?.role !== "child");
      await bridge.handleMessage({ type: "closePreview" });
      replayDetail = "replayed lane framed as subagent; plain preview not";
    }

    bridge.dispose();
    return [{
      name: "view state",
      ok: failures.length === 0,
      detail: failures.length === 0
        ? `live/lane/back transitions consistent; ${replayDetail}`
        : `failed: ${failures.join("; ")}`,
    }];
  } catch (error) {
    return [{ name: "view state", ok: false, detail: describe(error) }];
  } finally {
    child?.dispose();
    runtime?.dispose();
  }
}

/**
 * Offline check on the resource listing shown above the transcript: it must
 * come back with the tool registry, and mark as inactive the tools pi
 * registers but does not activate (`grep`/`find`/`ls`, unless an extension
 * turns them on).
 */
export async function runResourceListingTest(cwd: string): Promise<DiagnosticResult[]> {
  try {
    const { session } = await createAgentSession({
      cwd,
      excludeTools: ["subagent"],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const sections = collectResourceSections({ session, cwd });
    session.dispose();
    const tools = sections.find((section) => section.name === "Tools")?.items ?? [];
    const active = tools.filter((tool) => !tool.inactive).map((tool) => tool.label);
    const inactive = tools.filter((tool) => tool.inactive).map((tool) => tool.label);
    // Extension labels are the entry file's basename, so a directory-form
    // extension that forgot its `pi.extensions` manifest shows up here as a
    // useless `index.ts` — worth seeing without opening the panel.
    const extensions = sections.find((section) => section.name === "Extensions")?.items.map((item) => item.label) ?? [];
    return [{
      name: "resource listing",
      ok: tools.length > 0 && active.includes("read"),
      detail: `sections: ${sections.map((section) => `${section.name} ${section.items.length}`).join(", ")}; extensions: ${extensions.join(", ") || "(none)"}; tools active: ${active.join(", ") || "(none)"}; inactive: ${inactive.join(", ") || "(none)"}`,
    }];
  } catch (error) {
    return [{ name: "resource listing", ok: false, detail: describe(error) }];
  }
}

/**
 * Milestone 1 live check: run one real prompt that must trigger a bash tool call
 * inside the extension host, using a throwaway in-memory session.
 */
export async function runLiveToolCallTest(cwd: string, log: (message: string) => void): Promise<DiagnosticResult[]> {
  const marker = `pi-spike-${Date.now()}`;
  const results: DiagnosticResult[] = [];
  const toolCalls: string[] = [];
  const seenEvents = new Set<string>();
  let text = "";

  try {
    const { session } = await createAgentSession({
      cwd,
      tools: ["bash"],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const unsubscribe = session.subscribe((event) => {
      seenEvents.add(event.type);
      if (event.type === "tool_execution_start") {
        toolCalls.push(event.toolName);
        log(`live test: tool ${event.toolName} ${JSON.stringify(event.args).slice(0, 200)}`);
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
      }
    });

    results.push({
      name: "live session",
      ok: true,
      detail: `model=${(session.model as { id?: string } | undefined)?.id ?? "(none)"}, thinking=${session.thinkingLevel}`,
    });

    let accepted: boolean | undefined;
    await session.prompt(
      `Use the bash tool exactly once to print the text ${marker}, then reply with that text and nothing else.`,
      { preflightResult: (success) => (accepted = success) },
    );
    unsubscribe();

    const agentError = session.agent.state.errorMessage;
    session.dispose();

    results.push({
      name: "prompt accepted",
      ok: accepted !== false,
      detail: `preflight=${String(accepted)}, events=${[...seenEvents].join(",") || "(none)"}`,
    });
    if (agentError) {
      results.push({ name: "agent error", ok: false, detail: agentError.slice(0, 500) });
    }
    results.push({
      name: "tool execution",
      ok: toolCalls.includes("bash"),
      detail: toolCalls.length ? `tools called: ${toolCalls.join(", ")}` : "no tool was called",
    });
    results.push({
      name: "assistant response",
      ok: text.includes(marker),
      detail: text.trim().slice(0, 200) || "(empty)",
    });
  } catch (error) {
    results.push({ name: "live prompt", ok: false, detail: describe(error) });
  }

  return results;
}
