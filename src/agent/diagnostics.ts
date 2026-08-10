import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, getAgentDir, getPackageDir, SessionManager } from "@earendil-works/pi-coding-agent";
import { buildHistoryEntryEvents } from "./bridge.js";
import { collectSlashCommands } from "./commands.js";
import { describe } from "./errors.js";
import { buildTreeChoices } from "./session-tree.js";
import { SubagentCoordinator } from "./subagent.js";
import { ProjectFileIndex } from "./project-files.js";

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

/** Offline check: the application-provided subagent tool is registered and excludable. */
export async function runSubagentToolTest(cwd: string): Promise<DiagnosticResult[]> {
  const coordinator = new SubagentCoordinator(() => {});
  try {
    const parentResult = await createAgentSession({
      cwd,
      customTools: [coordinator.tool],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const parentHasTool = parentResult.session.agent.state.tools.some((tool) => tool.name === "subagent");
    parentResult.session.dispose();

    const childResult = await createAgentSession({
      cwd,
      customTools: [coordinator.tool],
      excludeTools: ["subagent"],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const childHasTool = childResult.session.agent.state.tools.some((tool) => tool.name === "subagent");
    childResult.session.dispose();
    await coordinator.dispose();

    return [{
      name: "subagent tool",
      ok: parentHasTool && !childHasTool,
      detail: `parent=${parentHasTool ? "enabled" : "missing"}, child=${childHasTool ? "unexpectedly enabled" : "excluded"}`,
    }];
  } catch (error) {
    await coordinator.dispose();
    return [{ name: "subagent tool", ok: false, detail: describe(error) }];
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
