import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TerminalConfig } from "../config.js";
import { describe } from "../errors.js";
import { replayTerminal } from "../terminal-replay.js";
import {
  PROGRESS_INTERVAL_MS,
  SHELL_INTEGRATION_TIMEOUT_MS,
  SHELL_TYPE_TIMEOUT_MS,
} from "./constants.js";
import {
  vscodeTerminalApi,
  type DisposableLike,
  type ExecutionLike,
  type ShellIntegrationLike,
  type TerminalApi,
  type TerminalLike,
} from "./api.js";
import type { CommandRecord, ManagedTerminal, RunArgs, TerminalTimeouts, TerminalToolUpdate } from "./types.js";
import { describeExit, OUTPUT_BANNER, truncate } from "./text.js";
import { abortSignalPromise, clampTimeout, delay, seconds, timer } from "./util.js";
import { createTerminalTool } from "./tool.js";

/* —— 终端池 --------------------------------------------------------------- */

/**
 * 本工具创建的终端及在其中跑过的命令。两条机制级规则塑造这里的一切：
 * 1. **只有这里创建的终端可见、可关**——用户或其他扩展开的终端永不进 list、
 *    永远关不掉，无论模型传什么 id。
 * 2. **绝不自动关闭任何终端**——终端是用户可能正在读、正在打字的地方。
 * 终端跨调用复用：真机探针测得新建约 4.3s、复用约 15ms，复用也让 shell
 * 自身状态（cwd、环境、变量）像真人面前那样延续。
 */
export class VsCodeTerminalPool {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private readonly subscriptions: DisposableLike[] = [];
  private subscribed = false;
  private counter = 0;
  private disposed = false;
  /** 每个终端等待 shell integration 的 resolver。 */
  private readonly integrationWaiters = new Map<TerminalLike, ((value: ShellIntegrationLike | undefined) => void)[]>();
  /** 等待某次执行结束的 resolver，按 execution 对象索引。 */
  private readonly executionWaiters = new Map<ExecutionLike, (exitCode: number | undefined) => void>();

  constructor(
    private readonly getCwd: () => string,
    private readonly log: (message: string) => void,
    private readonly api: TerminalApi = vscodeTerminalApi(),
    private readonly timeouts: TerminalTimeouts = {
      shellIntegrationMs: SHELL_INTEGRATION_TIMEOUT_MS,
      shellTypeMs: SHELL_TYPE_TIMEOUT_MS,
    },
  ) {}

  /**
   * 为单个会话构建工具定义。
   *
   * 与 subagent 工具一样按会话构建而非一次：description 目前不依赖配置，但
   * 工具集在会话构建时固定，改过的设置正是在这里落地。
   */
  createTool(config: TerminalConfig): ToolDefinition {
    return createTerminalTool(this, config);
  }

  // 丢弃事件订阅。终端有意保持打开（规则 2）。
  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.subscribed = false;
  }

  /* —— 动作 --------------------------------------------------------------- */

  /**
   * 执行一个动作。
   *
   * 公开且与上面的工具定义分离，`diagnostics.ts` 的自检才能用脚本化终端
   * API 驱动拒绝路径——无窗口、无 shell、无真人。这些正是绝不能退化成
   * 「报成功、什么都没做」的路径。
   */
  async execute(
    args: RunArgs,
    config: TerminalConfig,
    signal?: AbortSignal,
    onUpdate: (update: TerminalToolUpdate) => void = () => {},
  ): Promise<{ text: string; details: unknown }> {
    switch (args.action) {
      case "run":
        return await this.runCommand(args, config, signal, onUpdate);
      case "list":
        return this.listTerminals();
      case "read":
        return this.readTerminal(args);
      case "close":
        return this.closeTerminal(args);
      default:
        throw new Error(`Unknown action "${String(args.action)}". Use run, list, read or close.`);
    }
  }

  private async runCommand(
    args: RunArgs,
    config: TerminalConfig,
    signal: AbortSignal | undefined,
    onUpdate: (update: { text: string; details: unknown }) => void,
  ): Promise<{ text: string; details: unknown }> {
    const command = args.command?.trim();
    if (!command) throw new Error('`command` is required for action "run". Nothing was run.');
    const timeoutMs = clampTimeout(args.timeoutSeconds) * 1000;

    const { entry, created } = this.acquireTerminal(args.terminal, config);
    let integration: ShellIntegrationLike | undefined;
    try {
      integration = await this.ensureShellIntegration(entry);
    } catch (error) {
      if (created) this.destroy(entry);
      throw error;
    }
    if (!integration) {
      // 拒绝而不是盲跑：没有 shell integration 就什么都读不回来，而「跑了
      // 命令却什么都不返回」正是本宿主屏蔽扩展 `subagent` 的那种失败模式。
      if (created) this.destroy(entry);
      throw new Error(
        `VS Code shell integration did not activate in terminal ${entry.id} within ${this.timeouts.shellIntegrationMs}ms, ` +
          `so the command was NOT run and nothing was changed. Without it the terminal's output cannot be read back. ` +
          `The user can check the "terminal.integrated.shellIntegration.enabled" setting and their default shell ` +
          `profile (cmd, and shells started from a custom script, never get it).`,
      );
    }

    entry.terminal.show(true);
    const record: CommandRecord = {
      command,
      startedAt: Date.now(),
      raw: "",
      running: true,
      exitReported: false,
      terminalClosed: false,
      deliveredLines: 0,
    };
    entry.current = record;
    entry.last = record;

    const execution = integration.executeCommand(command);
    record.execution = execution;
    const ended = new Promise<void>((resolve) => {
      this.executionWaiters.set(execution, (exitCode) => {
        // 结束记账全部在这里做，不在下面 race 之后：命令完全可能在超时返回后
        // 才结束，留下的 record 正是后续 `read` 的报告来源。
        record.exitCode = exitCode;
        record.exitReported = true;
        record.running = false;
        record.endedAt = Date.now();
        if (entry.current === record) entry.current = undefined;
        this.executionWaiters.delete(execution);
        resolve();
      });
    });

    let lastProgressAt = 0;
    const reading = (async () => {
      for await (const chunk of execution.read()) {
        record.raw += chunk;
        const now = Date.now();
        if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
          lastProgressAt = now;
          onUpdate(this.progress(entry, record));
        }
      }
    })().catch(() => {});

    const wait = timer(timeoutMs);
    try {
      const finished = await Promise.race([
        Promise.all([reading, ended]).then(() => "ended" as const),
        wait.promise.then(() => "timeout" as const),
        abortSignalPromise(signal).then(() => "aborted" as const),
      ]);
      if (finished === "ended") return this.finishedResult(entry, record);
      // 绝不 kill：命令可能正停在用户即将回答的提示符上，kill 等于扔掉没人
      // 要求放弃的工作。
      return this.unfinishedResult(entry, record, finished);
    } finally {
      wait.cancel();
    }
  }

  private listTerminals(): { text: string; details: unknown } {
    const entries = [...this.terminals.values()];
    const lines = [
      entries.length === 0
        ? "vscode_terminal: no terminals open. A `run` without a terminal id creates one."
        : `vscode_terminal: ${entries.length} terminal(s) open.`,
      "Only terminals created by this tool are listed here; terminals opened by the user or by other extensions " +
        "are not visible to it and cannot be read or closed through it.",
    ];
    for (const entry of entries) {
      lines.push("");
      lines.push(`terminal ${entry.id}${entry.shell ? ` (${entry.shell})` : ""}: ${this.describeStatus(entry)}`);
      const record = entry.current ?? entry.last;
      if (record) {
        lines.push(`  last command: ${record.command}`);
        if (!record.running) lines.push(`  ${describeExit(record, entry.shell)}`);
        const unread = this.unreadLineCount(record);
        if (unread > 0) lines.push(`  ${unread} line(s) of output not yet returned; read them with action "read".`);
      }
    }
    return {
      text: lines.join("\n"),
      details: {
        terminals: entries.map((entry) => ({
          id: entry.id,
          shell: entry.shell,
          busy: Boolean(entry.current),
          command: (entry.current ?? entry.last)?.command,
        })),
      },
    };
  }

  private readTerminal(args: RunArgs): { text: string; details: unknown } {
    const entry = this.requireTerminal(args.terminal, "read");
    const record = entry.current ?? entry.last;
    if (!record) {
      return {
        text: `vscode_terminal read: terminal ${entry.id} has not run any command yet.`,
        details: { terminal: entry.id, lines: 0 },
      };
    }
    const delivered = this.take(record);
    const output = truncate(delivered);
    const header = record.running
      ? `vscode_terminal read: terminal ${entry.id} is still running \`${record.command}\` (${seconds(Date.now() - record.startedAt)}s so far).`
      : `vscode_terminal read: terminal ${entry.id} finished \`${record.command}\`. ${describeExit(record, entry.shell)}`;
    return {
      text: [header, ...(output.text ? [OUTPUT_BANNER, output.text] : ["(no new output since the last read)"]), ...output.notes].join("\n"),
      details: {
        terminal: entry.id,
        command: record.command,
        running: record.running,
        newLines: delivered.length,
        truncated: output.truncated,
      },
    };
  }

  private closeTerminal(args: RunArgs): { text: string; details: unknown } {
    const entry = this.requireTerminal(args.terminal, "close");
    const record = entry.current ?? entry.last;
    const wasRunning = Boolean(entry.current);
    const delivered = record ? this.take(record) : [];
    const output = truncate(delivered);
    this.destroy(entry);
    const lines = [
      `vscode_terminal close: terminal ${entry.id} was closed and is gone.` +
        (wasRunning ? ` The command \`${record?.command ?? ""}\` was still running and ended with it.` : ""),
      "Creating a replacement costs about 4 seconds before its first command can run, and it starts in a fresh " +
        "shell: the working directory, environment and shell variables of this one are gone.",
    ];
    if (output.text) lines.push(OUTPUT_BANNER, output.text, ...output.notes);
    return {
      text: lines.join("\n"),
      details: { terminal: entry.id, wasRunning, truncated: output.truncated },
    };
  }

  /* —— 结果 --------------------------------------------------------------- */

  private finishedResult(entry: ManagedTerminal, record: CommandRecord): { text: string; details: unknown } {
    const delivered = this.take(record);
    const output = truncate(delivered);
    const lines = [
      `vscode_terminal: ran \`${record.command}\` in terminal ${entry.id}${entry.shell ? ` (${entry.shell})` : ""}, ` +
        `which stays open for the next command.`,
      describeExit(record, entry.shell),
    ];
    if (output.text) lines.push(OUTPUT_BANNER, output.text);
    else lines.push("(the command produced no output)");
    lines.push(...output.notes);
    return {
      text: lines.join("\n"),
      details: {
        terminal: entry.id,
        command: record.command,
        exitCode: record.exitCode,
        durationMs: (record.endedAt ?? Date.now()) - record.startedAt,
        truncated: output.truncated,
      },
    };
  }

  private unfinishedResult(
    entry: ManagedTerminal,
    record: CommandRecord,
    reason: "timeout" | "aborted",
  ): { text: string; details: unknown } {
    const delivered = this.take(record);
    const output = truncate(delivered);
    const waited = seconds(Date.now() - record.startedAt);
    const lines = [
      `vscode_terminal: \`${record.command}\` is STILL RUNNING in terminal ${entry.id} after ${waited}s` +
        (reason === "aborted" ? ", and the wait was interrupted by the user." : "."),
      "It was not stopped and no output was lost. It may be waiting for input, which the user can type into " +
        `terminal ${entry.id} themselves, or it may simply take longer.`,
      `Call this tool again with action "read" and terminal "${entry.id}" for whatever happened since, ` +
        `or action "close" to end it.`,
    ];
    if (output.text) lines.push(OUTPUT_BANNER, output.text);
    else lines.push("(no output so far)");
    lines.push(...output.notes);
    return {
      text: lines.join("\n"),
      details: {
        terminal: entry.id,
        command: record.command,
        running: true,
        waitedMs: Date.now() - record.startedAt,
        truncated: output.truncated,
      },
    };
  }

  private progress(entry: ManagedTerminal, record: CommandRecord): { text: string; details: unknown } {
    const screen = replayTerminal(record.raw);
    const tail = screen.lines.slice(-3);
    const elapsed = seconds(Date.now() - record.startedAt);
    return {
      text: `terminal ${entry.id}: ${record.command} — ${elapsed}s, ${screen.lines.length} line(s)`,
      details: { terminal: entry.id, command: record.command, elapsedSeconds: Number(elapsed), tail },
    };
  }

  /* —— 终端记账 --------------------------------------------------------------- */

  // 现成的空闲终端、指定的那个，或新建一个。
  private acquireTerminal(requested: string | undefined, config: TerminalConfig): { entry: ManagedTerminal; created: boolean } {
    if (requested) {
      const entry = this.requireTerminal(requested, "run");
      if (entry.current) {
        throw new Error(
          `Terminal ${entry.id} is still running \`${entry.current.command}\`. Nothing was run. ` +
            `Use action "read" to see how it is going, action "close" to end it, or omit the terminal id to use another one.`,
        );
      }
      return { entry, created: false };
    }
    const free = [...this.terminals.values()].find((entry) => !entry.current && !entry.closed);
    if (free) return { entry: free, created: false };
    if (this.terminals.size >= config.maxTerminals) {
      const busy = [...this.terminals.values()]
        .map((entry) => `${entry.id}: ${entry.current?.command ?? "idle"}`)
        .join("; ");
      throw new Error(
        `All ${config.maxTerminals} terminals are busy, so nothing was run (${busy}). ` +
          `Wait for one with action "read", end one with action "close", or ask the user to raise ` +
          `"piAgentChat.terminal.maxTerminals".`,
      );
    }
    return { entry: this.create(), created: true };
  }

  private create(): ManagedTerminal {
    this.ensureSubscriptions();
    const id = String(++this.counter);
    const terminal = this.api.createTerminal({ name: `Pi agent ${id}`, cwd: this.getCwd() });
    // 终端一创建就显示，不等命令派发：shell 启动要一会儿、integration 更久，
    // 本工具的意义就是用户实时看见正在发生什么。
    terminal.show(true);
    const entry: ManagedTerminal = { id, terminal, createdAt: Date.now(), closed: false };
    this.terminals.set(id, entry);
    this.log(`vscode_terminal: created terminal ${id}`);
    return entry;
  }

  private destroy(entry: ManagedTerminal): void {
    entry.closed = true;
    this.terminals.delete(entry.id);
    if (entry.current) {
      entry.current.running = false;
      entry.current.terminalClosed = true;
      entry.current = undefined;
    }
    try {
      entry.terminal.dispose();
    } catch (error) {
      this.log(`vscode_terminal: disposing terminal ${entry.id} failed: ${describe(error)}`);
    }
  }

  /** 查找终端，拒绝一切非本池创建的对象。 */
  private requireTerminal(id: string | undefined, action: string): ManagedTerminal {
    if (!id) {
      throw new Error(
        `\`terminal\` is required for action "${action}". Use action "list" to see the terminals this tool has open.`,
      );
    }
    const entry = this.terminals.get(id.trim());
    if (!entry || entry.closed) {
      const open = [...this.terminals.keys()];
      throw new Error(
        `Terminal "${id}" is not one of the terminals this tool created, so nothing was done. ` +
          `Terminals the user or other extensions opened cannot be read or closed through this tool. ` +
          `Currently open: ${open.length > 0 ? open.join(", ") : "(none)"}.`,
      );
    }
    return entry;
  }

  /**
   * 订阅终端事件，仅一次且懒初始化。
   *
   * 懒是因为池在每个会话都会构造（无论工具是否开启），包括终端 API 根本
   * 不存在的无头自检；真正创建终端之前什么都不订阅。
   */
  private ensureSubscriptions(): void {
    if (this.subscribed || this.disposed) return;
    this.subscribed = true;
    this.subscriptions.push(
      this.api.onDidChangeTerminalShellIntegration((event) => {
        const entry = this.find(event.terminal);
        if (entry) entry.shellIntegration = event.shellIntegration;
        const waiters = this.integrationWaiters.get(event.terminal);
        if (waiters) {
          this.integrationWaiters.delete(event.terminal);
          for (const resolve of waiters) resolve(event.shellIntegration);
        }
      }),
      this.api.onDidEndTerminalShellExecution((event) => {
        this.executionWaiters.get(event.execution)?.(event.exitCode);
      }),
      this.api.onDidChangeTerminalState((terminal) => {
        const entry = this.find(terminal);
        if (entry && terminal.state.shell) entry.shell = terminal.state.shell;
      }),
      this.api.onDidCloseTerminal((terminal) => {
        const entry = this.find(terminal);
        if (!entry) return;
        entry.closed = true;
        this.terminals.delete(entry.id);
        const record = entry.current;
        if (record) {
          record.running = false;
          record.terminalClosed = true;
          entry.current = undefined;
          if (record.execution) this.executionWaiters.get(record.execution)?.(undefined);
        }
        this.log(`vscode_terminal: terminal ${entry.id} was closed`);
      }),
    );
  }

  private find(terminal: TerminalLike): ManagedTerminal | undefined {
    for (const entry of this.terminals.values()) if (entry.terminal === terminal) return entry;
    return undefined;
  }

  /**
   * 等待 shell integration，以及决定退出码口径的 shell 类型。
   *
   * `TerminalState.shell` 异步填充，integration 激活那一刻读到的是
   * `undefined`，不能读一次就信。
   */
  private async ensureShellIntegration(entry: ManagedTerminal): Promise<ShellIntegrationLike | undefined> {
    this.ensureSubscriptions();
    const existing = entry.shellIntegration ?? entry.terminal.shellIntegration;
    if (existing) {
      entry.shellIntegration = existing;
      await this.resolveShellType(entry);
      return existing;
    }
    const integration = await new Promise<ShellIntegrationLike | undefined>((resolve) => {
      const waiters = this.integrationWaiters.get(entry.terminal) ?? [];
      const wait = timer(this.timeouts.shellIntegrationMs);
      let settled = false;
      const settle = (value: ShellIntegrationLike | undefined) => {
        if (settled) return;
        settled = true;
        wait.cancel();
        const pending = this.integrationWaiters.get(entry.terminal);
        if (pending) {
          const index = pending.indexOf(settle);
          if (index >= 0) pending.splice(index, 1);
          if (pending.length === 0) this.integrationWaiters.delete(entry.terminal);
        }
        resolve(value);
      };
      waiters.push(settle);
      this.integrationWaiters.set(entry.terminal, waiters);
      void wait.promise.then(() => settle(entry.shellIntegration ?? entry.terminal.shellIntegration));
    });
    if (integration) {
      entry.shellIntegration = integration;
      await this.resolveShellType(entry);
    }
    return integration;
  }

  private async resolveShellType(entry: ManagedTerminal): Promise<void> {
    if (entry.shell) return;
    const immediate = entry.terminal.state.shell;
    if (immediate) {
      entry.shell = immediate;
      return;
    }
    const deadline = Date.now() + this.timeouts.shellTypeMs;
    while (Date.now() < deadline) {
      await delay(50);
      const shell = entry.terminal.state.shell;
      if (shell) {
        entry.shell = shell;
        return;
      }
    }
  }

  /* —— 输出 --------------------------------------------------------------- */

  /**
   * 距上次读取新产生的行。
   *
   * 每次都重放整段流——光标指令参照整块屏幕，只放尾巴会渲染到一个从未存在
   * 的屏幕上。光标*之前*的行算已交付；光标行本身每次重发，因为那是进度条
   * 不断重写的行。没有这条规则，要么每次重绘都算新行，要么行数变短被当成
   * 重置而整屏重发。
   */
  private take(record: CommandRecord): string[] {
    const screen = replayTerminal(record.raw);
    const settled = screen.cursorLine;
    const start = Math.min(record.deliveredLines, settled);
    record.deliveredLines = settled;
    return screen.lines.slice(start);
  }

  private unreadLineCount(record: CommandRecord): number {
    const screen = replayTerminal(record.raw);
    return Math.max(0, screen.cursorLine - record.deliveredLines);
  }

  private describeStatus(entry: ManagedTerminal): string {
    if (entry.current) {
      return `running \`${entry.current.command}\` (${seconds(Date.now() - entry.current.startedAt)}s so far)`;
    }
    return "idle";
  }
}
