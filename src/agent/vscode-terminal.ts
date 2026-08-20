import * as vscode from "vscode";
import { Type } from "typebox";
import {
  defineTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TerminalConfig } from "./config.js";
import { describe } from "./errors.js";
import { replayTerminal } from "./terminal-replay.js";

/**
 * Name of the terminal tool this host adds to pi's own set.
 *
 * Prefixed rather than a bare `terminal` for two reasons. It collides with far
 * less in the extension ecosystem, and the plugin's rule is that a name it
 * claims resolves to its own tool or to nothing — so the cheapest way to keep
 * that promise is to claim a name nobody else wants. And it is self-describing
 * across hosts: a session resumed in the CLI, where this tool does not exist,
 * shows a name that says which host it belonged to.
 */
export const VSCODE_TERMINAL_TOOL = "vscode_terminal";

/**
 * How long to wait for shell integration on a freshly created terminal.
 *
 * The spike measured ~590ms on a warm machine; the budget is generous because
 * the alternative to waiting is refusing to run the command at all.
 */
const SHELL_INTEGRATION_TIMEOUT_MS = 10_000;

/** How long to wait for `TerminalState.shell`, which is filled asynchronously. */
const SHELL_TYPE_TIMEOUT_MS = 5_000;

const DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * Ceiling for `timeoutSeconds`.
 *
 * A command is never killed on timeout, so this bound is not about the command:
 * it is about the agent, which is blocked inside one tool call until the wait
 * ends. Five minutes is long enough for installs and builds and short enough
 * that a session cannot be parked forever on a prompt nobody is watching.
 */
const MAX_TIMEOUT_SECONDS = 300;

/** Minimum gap between live progress updates pushed to the tool card. */
const PROGRESS_INTERVAL_MS = 250;

/** Shell types whose integration reports only success/failure (see `describeExit`). */
const BOOLEAN_EXIT_SHELLS = new Set(["pwsh", "powershell"]);

/* -- Host surface -------------------------------------------------------- */

/**
 * The slice of the VS Code terminal API this module uses.
 *
 * Injected rather than reached for directly so the self-checks in
 * `diagnostics.ts` can drive the refusal paths — no shell integration, closing
 * a terminal the tool never created — without a window, a shell or a human.
 * Those are exactly the paths that must never degrade into "reported success,
 * did nothing".
 */
export interface TerminalApi {
  createTerminal(options: { name: string; cwd: string }): TerminalLike;
  onDidChangeTerminalShellIntegration(
    listener: (event: { terminal: TerminalLike; shellIntegration: ShellIntegrationLike }) => void,
  ): DisposableLike;
  onDidEndTerminalShellExecution(
    listener: (event: { terminal: TerminalLike; execution: ExecutionLike; exitCode: number | undefined }) => void,
  ): DisposableLike;
  onDidCloseTerminal(listener: (terminal: TerminalLike) => void): DisposableLike;
  onDidChangeTerminalState(listener: (terminal: TerminalLike) => void): DisposableLike;
}

export interface DisposableLike {
  dispose(): void;
}

export interface TerminalLike {
  readonly name: string;
  readonly shellIntegration?: ShellIntegrationLike | undefined;
  readonly state: { readonly shell?: string | undefined };
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface ShellIntegrationLike {
  executeCommand(commandLine: string): ExecutionLike;
}

export interface ExecutionLike {
  read(): AsyncIterable<string>;
}

/** The real API, wrapped explicitly so the structural mapping stays visible. */
export function vscodeTerminalApi(): TerminalApi {
  return {
    createTerminal: (options) =>
      vscode.window.createTerminal({
        name: options.name,
        cwd: options.cwd,
        iconPath: new vscode.ThemeIcon("sparkle"),
      }),
    onDidChangeTerminalShellIntegration: (listener) =>
      vscode.window.onDidChangeTerminalShellIntegration((event) =>
        listener({ terminal: event.terminal, shellIntegration: event.shellIntegration }),
      ),
    onDidEndTerminalShellExecution: (listener) =>
      vscode.window.onDidEndTerminalShellExecution((event) =>
        listener({ terminal: event.terminal, execution: event.execution, exitCode: event.exitCode }),
      ),
    onDidCloseTerminal: (listener) => vscode.window.onDidCloseTerminal((terminal) => listener(terminal)),
    onDidChangeTerminalState: (listener) => vscode.window.onDidChangeTerminalState((terminal) => listener(terminal)),
  };
}

/* -- Pool state ---------------------------------------------------------- */

/** One command run in a terminal, and everything read back from it. */
interface CommandRecord {
  command: string;
  startedAt: number;
  endedAt?: number;
  /** Every byte the terminal produced, escape sequences included. */
  raw: string;
  execution?: ExecutionLike;
  running: boolean;
  exitCode?: number;
  exitReported: boolean;
  /** The terminal disappeared while this command was running. */
  terminalClosed: boolean;
  /**
   * Settled screen rows already handed to the model.
   *
   * Counted in rows rather than bytes because the replay is done over the
   * whole stream every time: only replaying the tail would lose the screen
   * context that the cursor operations refer to.
   */
  deliveredLines: number;
}

interface ManagedTerminal {
  id: string;
  terminal: TerminalLike;
  shellIntegration?: ShellIntegrationLike;
  /** `TerminalState.shell`, once VS Code fills it in. */
  shell?: string;
  createdAt: number;
  closed: boolean;
  current?: CommandRecord;
  last?: CommandRecord;
}

interface RunArgs {
  action: "run" | "list" | "read" | "close";
  command?: string;
  terminal?: string;
  timeoutSeconds?: number;
}

/** Arguments of one `vscode_terminal` call, as the model sends them. */
export type TerminalToolArgs = RunArgs;

/** Live progress pushed to the tool card while a command runs. */
export interface TerminalToolUpdate {
  text: string;
  details: unknown;
}

/** Waiting budgets, overridable so the self-checks need no real shell. */
export interface TerminalTimeouts {
  shellIntegrationMs: number;
  shellTypeMs: number;
}

/* -- The pool ------------------------------------------------------------ */

/**
 * Terminals this tool created, and the commands run in them.
 *
 * Two rules shape everything here, and both are mechanical rather than
 * advisory:
 *
 * 1. **Only terminals created here are visible or closable.** A terminal the
 *    user opened, or one belonging to another extension, is never listed and
 *    cannot be closed, whatever id the model passes.
 * 2. **Nothing is ever closed automatically.** A terminal is a place the user
 *    may be reading or typing; tidying it away after a task is the same class
 *    of mistake as yanking the view out from under someone.
 *
 * Terminals are reused across calls: the spike measured ~4.3s to create one
 * and ~15ms to dispatch into an existing one, and reuse is also what makes the
 * shell's own state (cwd, environment, variables) carry over the way it does
 * for a human at the same prompt.
 */
export class VsCodeTerminalPool {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private readonly subscriptions: DisposableLike[] = [];
  private subscribed = false;
  private counter = 0;
  private disposed = false;
  /** Resolvers waiting for shell integration, per terminal. */
  private readonly integrationWaiters = new Map<TerminalLike, ((value: ShellIntegrationLike | undefined) => void)[]>();
  /** Resolvers waiting for an execution to end, keyed by the execution object. */
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
   * Build the tool definition for one session.
   *
   * Per session rather than once, like the subagent tool: nothing in the
   * description depends on the configuration today, but the tool set is fixed
   * when a session is built, so this is the point where a changed setting
   * lands.
   */
  createTool(config: TerminalConfig): ToolDefinition {
    const parameters = Type.Object({
      action: Type.Union(
        [Type.Literal("run"), Type.Literal("list"), Type.Literal("read"), Type.Literal("close")],
        {
          description:
            "run: execute a command. list: show the terminals this tool has open. " +
            "read: return output produced since the last read, for a command that had not finished. " +
            "close: dispose one of this tool's terminals, ending whatever is running in it.",
        },
      ),
      command: Type.Optional(Type.String({ description: "The command line to run. Required for `run`." })),
      terminal: Type.Optional(
        Type.String({
          description:
            "Id of a terminal from `list`. For `run`, reuse that terminal instead of any free one; " +
            "required for `read` and `close`.",
        }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: MAX_TIMEOUT_SECONDS,
          description:
            `How long to wait for the command before returning (default ${DEFAULT_TIMEOUT_SECONDS}, maximum ${MAX_TIMEOUT_SECONDS}). ` +
            "On timeout the command is left running and the output so far is returned.",
        }),
      ),
    });

    return defineTool({
      name: VSCODE_TERMINAL_TOOL,
      label: "VS Code terminal",
      description: TOOL_DESCRIPTION,
      promptSnippet: "Run a command in a VS Code terminal that stays visible to the user and accepts their typing",
      parameters,
      executionMode: "sequential",
      execute: async (_toolCallId, params, signal, onUpdate) => {
        const result = await this.execute(params as RunArgs, config, signal, (update) =>
          onUpdate?.({ content: [{ type: "text", text: update.text }], details: update.details }),
        );
        return { content: [{ type: "text" as const, text: result.text }], details: result.details };
      },
    }) as ToolDefinition;
  }

  /** Drop event subscriptions. Terminals are left open on purpose (rule 2). */
  dispose(): void {
    this.disposed = true;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.subscribed = false;
  }

  /* -- Actions ----------------------------------------------------------- */

  /**
   * Run one action.
   *
   * Public, and separate from the tool definition above, so the self-checks in
   * `diagnostics.ts` can drive the refusal paths against a scripted terminal
   * API — no window, no shell, no human. Those are the paths that must never
   * decay into "reported success, did nothing".
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
      // Refuse rather than run blind: without shell integration nothing can be
      // read back, and a tool that runs commands and returns nothing is the
      // exact failure mode this host shadows extension `subagent`s for.
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
        // All end bookkeeping happens here, not after the race below: the
        // command may well end *after* this call returned on a timeout, and
        // the record it leaves behind is what a later `read` reports from.
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
      // Never killed: the command may be sitting at a prompt the user is about
      // to answer, and killing it would throw away work nobody asked to
      // abandon.
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

  /* -- Results ----------------------------------------------------------- */

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

  /* -- Terminal bookkeeping ---------------------------------------------- */

  /** An existing free terminal, the requested one, or a new one. */
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
    // Shown as soon as it exists, not once a command is dispatched: the shell
    // takes a moment to start and integration a moment more, and the point of
    // this tool is that the user sees what is happening while it happens.
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

  /** Look a terminal up, refusing anything this pool did not create. */
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
   * Subscribe to terminal events, once and lazily.
   *
   * Lazily because the pool is constructed for every session whether or not
   * the tool is enabled, including in headless self-checks where the terminal
   * API is not present at all; nothing is subscribed until a terminal is
   * actually created.
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
   * Wait for shell integration, and for the shell type that decides how an
   * exit code may be reported.
   *
   * `TerminalState.shell` is filled in asynchronously and reads as `undefined`
   * at the moment integration activates, so it cannot be read once and
   * believed.
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

  /* -- Output ------------------------------------------------------------ */

  /**
   * Rows produced since the last read.
   *
   * The whole stream is replayed every time — cursor operations refer to the
   * screen as a whole, so replaying only the tail would render against a
   * screen that never existed. Rows *before* the cursor are settled and
   * counted as delivered; the cursor row itself is re-sent on every read
   * because that is the row a progress bar keeps rewriting. Without that rule
   * either every repaint reads as a new line, or the shrinking line count
   * looks like a reset and the whole screen is re-sent.
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

/* -- Text helpers -------------------------------------------------------- */

const OUTPUT_BANNER =
  "--- terminal output (the screen as it appears, including the shell prompt, the echoed command line and " +
  "anything the user typed into the terminal) ---";

/**
 * Exit status, phrased by what the shell integration can actually report.
 *
 * VS Code's `shellIntegration.ps1` puts `[int]!$?` in the OSC 633 `D` sequence
 * — its own source calls the variable `$FakeCode` — so on PowerShell only
 * success and failure survive; `shellIntegration-bash.sh` sends the real `$?`.
 * Passing that `1` on as if it were the command's exit code would be a
 * fabricated fact, and exit codes carry meaning the model reasons about (`grep`
 * 1 = no match but 2 = error; `diff` 1 = differences but 2 = trouble). So the
 * two shells are described differently, on purpose.
 */
function describeExit(record: CommandRecord, shell: string | undefined): string {
  if (record.terminalClosed) return "The terminal was closed before the command finished, so it has no exit status.";
  if (record.running) return "Still running.";
  if (!record.exitReported || record.exitCode === undefined) {
    return "The shell reported no exit status for it (it may have been interrupted).";
  }
  const ok = record.exitCode === 0;
  if (shell && BOOLEAN_EXIT_SHELLS.has(shell)) {
    return ok
      ? "The command succeeded. (PowerShell's shell integration reports only success or failure, never the exit code itself.)"
      : "The command FAILED. (PowerShell's shell integration reports only success or failure, so the real exit code is not available here.)";
  }
  if (!shell) {
    return ok
      ? "The command succeeded (exit code 0)."
      : `The command FAILED (the shell reported exit code ${record.exitCode}; some shells, PowerShell among them, report only success or failure).`;
  }
  return ok ? "The command succeeded (exit code 0)." : `The command FAILED with exit code ${record.exitCode}.`;
}

/**
 * Keep a transcript inside the same budget pi's own `bash` tool uses.
 *
 * A terminal transcript is strictly larger than a command's stdout — prompts,
 * the echoed command line, redrawn progress bars — so the discipline matters
 * more here, not less. The tail is kept, as `bash` does: the end of a command
 * is where its result is.
 */
function truncate(lines: string[]): { text: string; truncated: boolean; notes: string[] } {
  const joined = lines.join("\n");
  const result = truncateTail(joined, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!result.truncated) return { text: result.content, truncated: false, notes: [] };
  return {
    text: result.content,
    truncated: true,
    notes: [
      `--- only the last ${result.outputLines} of ${result.totalLines} line(s) are shown; ` +
        `the earlier output is not available through this tool ---`,
    ],
  };
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, Math.round(value)));
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A cancellable delay, so a finished command leaves no timer behind. */
function timer(ms: number): { promise: Promise<void>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => (handle === undefined ? undefined : clearTimeout(handle)) };
}

function abortSignalPromise(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise<void>(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

/**
 * What the model is told about this tool.
 *
 * States mechanism only — what the tool does, what it costs, what it cannot
 * render faithfully — and no policy. When to prefer it, how it relates to
 * other command-running tools, and whether a project wants it used at all are
 * the user's to write in `~/.pi/agent/APPEND_SYSTEM.md` or a project
 * `AGENTS.md`, where the CLI and this host share them.
 */
const TOOL_DESCRIPTION = `Run a command in a VS Code integrated terminal that stays visible to the user.
The user can watch the command and type into it while it runs; anything they
type is included in the returned transcript.

The terminal persists across calls, so shell state — working directory,
environment variables, shell variables — carries over from one command to the
next. Creating a terminal costs about 4 seconds before its first command can
run; reusing an existing one costs about 15ms.

Output is rendered by replaying the terminal's cursor movements, so line
editing and progress bars read as they appear on screen; full-screen programs
are not rendered faithfully.

A command that has not finished within its timeout is left running, and the
output so far is returned; use "read" for what happened since, or "close" to
end it. Only terminals this tool created can be listed, read or closed.

Requires VS Code shell integration. Where it is not available the command is
not run and an error is returned instead. Exit codes are exact on POSIX
shells; on PowerShell only success or failure is available.`;
