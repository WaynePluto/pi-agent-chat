/** `vscode_terminal` 工具及其脚本化终端驱动的自检。 */
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
import { findShadowedExtensionTool } from "../runtime.js";
import {
  VsCodeTerminalPool,
  VSCODE_TERMINAL_TOOL,
  type DisposableLike,
  type ExecutionLike,
  type ShellIntegrationLike,
  type TerminalApi,
  type TerminalLike,
  type TerminalTimeouts,
} from "../vscode-terminal.js";
import type { DiagnosticResult } from "../diagnostics.js";

/* -- vscode_terminal 工具 ------------------------------------------------ */

/** 一个占用 `vscode_terminal` 工具名的 pi 扩展。 */
const TERMINAL_PROBE_EXTENSION = `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "vscode_terminal",
    label: "VS Code terminal",
    description: "diagnostic probe",
    parameters: Type.Object({ command: Type.String() }),
    execute: async () => ({ content: [{ type: "text", text: "probe" }], details: {} }),
  });
}
`;

/**
 * 终端工具的离线检查。全部跑在脚本化终端 API 上而非真窗口——只有这样
 * 才钉得住两件最重要且正常运行中看不见的行为：缺 shell integration
 * 必须拒绝而不是报空成功；close 碰不了本工具没创建的终端。关闭是默认
 * 态，必须意味着名字干脆不存在。
 */
export async function runTerminalToolTest(cwd: string): Promise<DiagnosticResult[]> {
  const pool = new VsCodeTerminalPool(() => cwd, () => {}, new ScriptedTerminalApi(), FAST_TIMEOUTS);
  const tool = pool.createTool({ enabled: true, maxTerminals: 3 });
  try {
    const baseline = await createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd) });
    const baselineActive = new Set(baseline.session.getActiveToolNames());
    baseline.session.dispose();

    const on = await createAgentSession({
      cwd,
      customTools: [tool],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const onActive = new Set(on.session.getActiveToolNames());
    on.session.dispose();

    const off = await createAgentSession({
      cwd,
      customTools: [],
      excludeTools: [VSCODE_TERMINAL_TOOL],
      sessionManager: SessionManager.inMemory(cwd),
    });
    const offActive = new Set(off.session.getActiveToolNames());
    off.session.dispose();

    const displaced = [...baselineActive].filter((name) => !onActive.has(name));
    const results: DiagnosticResult[] = [{
      name: "terminal tool",
      ok: onActive.has(VSCODE_TERMINAL_TOOL) && !offActive.has(VSCODE_TERMINAL_TOOL) && displaced.length === 0,
      detail:
        `enabled=${onActive.has(VSCODE_TERMINAL_TOOL) ? "active" : "MISSING"}; ` +
        `disabled=${offActive.has(VSCODE_TERMINAL_TOOL) ? "still present" : "absent"}; ` +
        `displaced=${displaced.join(", ") || "(none)"}`,
    }];
    results.push(...(await checkTerminalShadow(cwd, tool)));
    results.push(...(await checkTerminalBehaviour(cwd)));
    return results;
  } catch (error) {
    return [{ name: "terminal tool", ok: false, detail: describe(error) }];
  } finally {
    pool.dispose();
  }
}

/**
 * 扩展的 `vscode_terminal` 绝不能到达本宿主的模型——与 `subagent` 同一
 * 规则、同一机制、同一查法：名字归本窗口的工具，无论开关（注册表覆盖）
 * 还是关闭（直接排除）。宿主工具靠 description 内容识别（讲用户可见的
 * 终端，探针的不讲）。
 */
async function checkTerminalShadow(cwd: string, tool: ToolDefinition): Promise<DiagnosticResult[]> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "pi-vscode-terminal-ext-"));
    await writeFile(join(dir, "index.ts"), TERMINAL_PROBE_EXTENSION, "utf8");
    const services = await createAgentSessionServices({
      cwd,
      resourceLoaderOptions: { additionalExtensionPaths: [dir] },
    });
    const shadowed = findShadowedExtensionTool(services, VSCODE_TERMINAL_TOOL);

    const off = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      excludeTools: [VSCODE_TERMINAL_TOOL],
    });
    const offClean = !off.session.getActiveToolNames().includes(VSCODE_TERMINAL_TOOL);
    off.session.dispose();

    const on = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      customTools: [tool],
    });
    const onOurs = isHostTerminalTool(on.session);
    await on.session.reload();
    const reloadOurs = isHostTerminalTool(on.session);
    on.session.dispose();

    return [{
      name: "terminal tool shadowing",
      ok: shadowed === dir && offClean && onOurs && reloadOurs,
      detail:
        `detected=${shadowed ?? "(none)"}; off=${offClean ? "absent" : "LEAKED"}; ` +
        `on=${onOurs ? "host tool wins" : "EXTENSION TOOL EXPOSED"}; ` +
        `after reload=${reloadOurs ? "host tool wins" : "EXTENSION TOOL EXPOSED"}`,
    }];
  } catch (error) {
    return [{ name: "terminal tool shadowing", ok: false, detail: describe(error) }];
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function isHostTerminalTool(session: AgentSession): boolean {
  const info = session.getAllTools().find((entry) => entry.name === VSCODE_TERMINAL_TOOL);
  return info?.description?.includes("stays visible to the user") ?? false;
}

/**
 * 真终端无法按需演示的行为。1. 无 shell integration 就不执行：盲跑会返回
 * 空成功——正是本宿主屏蔽扩展版 subagent 的那个失败模式，且为这次尝试
 * 创建的终端不能留下。2. 超过超时的命令不被 kill，结果如实说——它可能
 * 在等用户键入。3. read 只返回新内容：进度条重绘同一行不能重发整屏。
 * 4. close 只碰本工具创建的终端：用户或其他扩展开的终端无论传什么 id
 * 都必须幸存。
 */
async function checkTerminalBehaviour(cwd: string): Promise<DiagnosticResult[]> {
  const failures: string[] = [];
  const notes: string[] = [];

  // 1. 无 shell integration。
  {
    const api = new ScriptedTerminalApi({ shellIntegration: false });
    const pool = new VsCodeTerminalPool(() => cwd, () => {}, api, FAST_TIMEOUTS);
    let refused = false;
    try {
      await pool.execute({ action: "run", command: "echo hi" }, { enabled: true, maxTerminals: 3 });
    } catch {
      refused = true;
    }
    if (!refused) failures.push("a command ran (or reported success) without shell integration");
    if (api.terminals.some((terminal) => !terminal.disposed)) {
      failures.push("the terminal created for a refused command was left open");
    }
    notes.push(`no integration: ${refused ? "refused" : "RAN ANYWAY"}`);
    pool.dispose();
  }

  // 2 与 3：一条不结束的命令，随后增量读——先无新内容、再多一行时，read 只报新的那行。
  {
    const api = new ScriptedTerminalApi({ script: { chunks: ["one\r\n", "two\r\n"], end: false } });
    const pool = new VsCodeTerminalPool(() => cwd, () => {}, api, FAST_TIMEOUTS);
    const config = { enabled: true, maxTerminals: 3 };
    const run = await pool.execute({ action: "run", command: "npm install", timeoutSeconds: 1 }, config);
    const stillRunning = run.text.includes("STILL RUNNING") && run.text.includes("one");
    if (!stillRunning) failures.push(`an unfinished command was not reported as running: ${oneLine(run.text)}`);
    if (api.terminals.some((terminal) => terminal.disposed)) {
      failures.push("a command that timed out had its terminal disposed");
    }
    const idle = await pool.execute({ action: "read", terminal: "1" }, config);
    api.push("three\r\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await pool.execute({ action: "read", terminal: "1" }, config);
    if (idle.text.includes("one")) failures.push("a second read repeated output already delivered");
    if (!after.text.includes("three") || after.text.includes("one")) {
      failures.push(`an incremental read did not return exactly the new output: ${oneLine(after.text)}`);
    }
    notes.push(`unfinished: ${stillRunning ? "reported running" : "MISREPORTED"}`);
    pool.dispose();
  }

  // 4. 关闭。
  {
    const api = new ScriptedTerminalApi({ script: { chunks: ["done\r\n"], end: true, exitCode: 0 } });
    const pool = new VsCodeTerminalPool(() => cwd, () => {}, api, FAST_TIMEOUTS);
    const config = { enabled: true, maxTerminals: 3 };
    const foreign = api.openForeignTerminal();
    const finished = await pool.execute({ action: "run", command: "echo done" }, config);
    if (!finished.text.includes("done") || !finished.text.includes("succeeded")) {
      failures.push(`a finished command did not report its output and status: ${oneLine(finished.text)}`);
    }
    let refusedForeign = false;
    try {
      await pool.execute({ action: "close", terminal: "999" }, config);
    } catch {
      refusedForeign = true;
    }
    if (!refusedForeign) failures.push("close accepted a terminal id this tool never created");
    if (foreign.disposed) failures.push("close disposed a terminal that belongs to somebody else");
    await pool.execute({ action: "close", terminal: "1" }, config);
    const own = api.terminals.find((terminal) => terminal !== foreign);
    if (!own?.disposed) failures.push("close did not dispose the tool's own terminal");
    notes.push(`close: foreign ${refusedForeign ? "refused" : "ACCEPTED"}, own ${own?.disposed ? "disposed" : "KEPT"}`);
    pool.dispose();
  }

  return [{
    name: "terminal tool behaviour",
    ok: failures.length === 0,
    detail: failures.length === 0 ? notes.join("; ") : failures.join("; "),
  }];
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").slice(0, 160);
}

const FAST_TIMEOUTS: TerminalTimeouts = { shellIntegrationMs: 50, shellTypeMs: 50 };

interface TerminalScript {
  chunks: string[];
  end: boolean;
  exitCode?: number;
}

class ScriptedTerminal implements TerminalLike {
  disposed = false;
  shellIntegration?: ShellIntegrationLike;
  constructor(
    readonly name: string,
    readonly state: { shell?: string },
    private readonly onDispose: (terminal: ScriptedTerminal) => void,
  ) {}
  show(): void {}
  dispose(): void {
    this.disposed = true;
    this.onDispose(this);
  }
}

/**
 * 按脚本而非 shell 应答的终端 API。刻意最小化：它只为抵达拒绝与超时
 * 路径而生，真终端只能靠运气走到那些分支。push 向运行中的执行喂一个
 * 块；openForeignTerminal 造一个本池没创建的终端（如用户或其他扩展
 * 所开）；onDidChangeTerminalShellIntegration 恒空——脚本终端到场即带
 * 集成，缺失分支永不 resolve。
 */
class ScriptedTerminalApi implements TerminalApi {
  readonly terminals: ScriptedTerminal[] = [];
  private readonly closeListeners: ((terminal: TerminalLike) => void)[] = [];
  private readonly endListeners: ((event: { terminal: TerminalLike; execution: ExecutionLike; exitCode: number | undefined }) => void)[] = [];
  private current?: { terminal: ScriptedTerminal; execution: ExecutionLike; push: (chunk: string) => void; close: () => void };

  constructor(private readonly options: { shellIntegration?: boolean; script?: TerminalScript } = {}) {}

  push(chunk: string): void {
    this.current?.push(chunk);
  }

  openForeignTerminal(): ScriptedTerminal {
    const terminal = new ScriptedTerminal("foreign", { shell: "bash" }, () => {});
    this.terminals.push(terminal);
    return terminal;
  }

  createTerminal(options: { name: string; cwd: string }): TerminalLike {
    const terminal = new ScriptedTerminal(options.name, { shell: "bash" }, (closed) => {
      for (const listener of this.closeListeners) listener(closed);
    });
    if (this.options.shellIntegration !== false) {
      terminal.shellIntegration = { executeCommand: () => this.startExecution(terminal) };
    }
    this.terminals.push(terminal);
    return terminal;
  }

  private startExecution(terminal: ScriptedTerminal): ExecutionLike {
    const script = this.options.script ?? { chunks: [], end: true, exitCode: 0 };
    const queue: string[] = [...script.chunks];
    let notify: (() => void) | undefined;
    let closed = false;
    const execution: ExecutionLike = {
      read: async function* read() {
        while (true) {
          while (queue.length > 0) yield queue.shift() as string;
          if (closed) return;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      },
    };
    const push = (chunk: string) => {
      queue.push(chunk);
      notify?.();
      notify = undefined;
    };
    const close = () => {
      closed = true;
      notify?.();
      notify = undefined;
    };
    this.current = { terminal, execution, push, close };
    if (script.end) {
      setTimeout(() => {
        close();
        for (const listener of this.endListeners) listener({ terminal, execution, exitCode: script.exitCode });
      }, 5);
    }
    return execution;
  }

  onDidChangeTerminalShellIntegration(): DisposableLike {
    return { dispose() {} };
  }

  onDidEndTerminalShellExecution(
    listener: (event: { terminal: TerminalLike; execution: ExecutionLike; exitCode: number | undefined }) => void,
  ): DisposableLike {
    this.endListeners.push(listener);
    return { dispose: () => this.endListeners.splice(this.endListeners.indexOf(listener), 1) };
  }

  onDidCloseTerminal(listener: (terminal: TerminalLike) => void): DisposableLike {
    this.closeListeners.push(listener);
    return { dispose: () => this.closeListeners.splice(this.closeListeners.indexOf(listener), 1) };
  }

  onDidChangeTerminalState(): DisposableLike {
    return { dispose() {} };
  }
}
