import * as vscode from "vscode";
import type { DiagnosticResult } from "./diagnostics.js";
import { findReplayFailures, replayTerminal, REPLAY_CASES } from "./terminal-replay.js";

/**
 * Spike for the proposed `terminal` tool (VS Code integrated terminal as a
 * command-execution surface the user can type into).
 *
 * This is deliberately *not* part of `runSpikeDiagnostics()`: that set runs
 * headless in `scripts/smoke_load.mjs` against a stubbed `vscode` module, and
 * everything here needs a real window, a real shell, and — for the probe that
 * actually decides the design — a human at the keyboard.
 *
 * Three questions decide whether the tool is buildable at all:
 *
 *   1. Does `Terminal.shellIntegration` activate, and how long does it take?
 *      Without it there is no way to read output back, and a tool that runs
 *      commands but returns nothing reproduces exactly the failure mode the
 *      extension-side `subagent` is shadowed for (exit 0 + empty output).
 *   2. Does `TerminalShellExecution.read()` include text the *user* typed?
 *      The whole premise is "user answers the prompt directly"; if their
 *      keystrokes never reach the stream, the agent cannot know what happened.
 *   3. Is `exitCode` actually reported?
 *
 * Everything else measured here (stream noise, streaming latency) feeds the
 * cost side of the decision rather than the go/no-go.
 */

const ACTIVATION_TIMEOUT_MS = 10_000;
const SHELL_TYPE_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 15_000;
const INTERACTIVE_TIMEOUT_MS = 90_000;

/**
 * Command syntax families. Kept coarser than `TerminalState.shell` because the
 * only thing the probes need is which dialect to emit — but `unsupported` is a
 * distinct outcome from `unknown`: the former is a definitive "do not run
 * anything here", the latter is "guess and report low confidence".
 */
type ShellFamily = "pwsh" | "posix" | "fish" | "unsupported" | "unknown";

/** The subset that has a command dialect the probes can emit. */
type Dialect = "pwsh" | "posix" | "fish";

/** Values `TerminalState.shell` is documented to produce, mapped to a dialect. */
const SHELL_FAMILIES: Record<string, ShellFamily> = {
  bash: "posix",
  gitbash: "posix",
  wsl: "posix",
  zsh: "posix",
  ksh: "posix",
  sh: "posix",
  fish: "fish",
  pwsh: "pwsh",
  // cmd never gets shell integration; csh has no `read -p`; the rest are REPLs
  // that happen to be running inside a terminal, not shells to run commands in.
  cmd: "unsupported",
  csh: "unsupported",
  nu: "unsupported",
  node: "unsupported",
  python: "unsupported",
  julia: "unsupported",
};

export async function runTerminalIntegrationSpike(
  cwd: string,
  log: (message: string) => void,
): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];
  results.push(describeEnvironment());
  // Deterministic and terminal-free, so it still reports when everything below
  // is skipped for want of shell integration.
  results.push(probeReplayFixture());
  const terminal = vscode.window.createTerminal({
    name: "pi spike",
    cwd,
    // Keep it out of the user's terminal history once disposed.
    isTransient: true,
  });

  try {
    terminal.show(true);

    const activationStartedAt = Date.now();
    const shellIntegration = await waitForShellIntegration(terminal, ACTIVATION_TIMEOUT_MS);
    const activationMs = Date.now() - activationStartedAt;

    if (!shellIntegration) {
      const reported = terminal.state.shell;
      const known = reported ? SHELL_FAMILIES[reported] : undefined;
      results.push({
        name: "terminal shell integration",
        ok: false,
        detail:
          `not activated within ${ACTIVATION_TIMEOUT_MS}ms (TerminalState.shell=${reported ?? "undefined"}` +
          `${known === "unsupported" ? ", a shell that never gets shell integration" : ""}). ` +
          `Output cannot be read back here, so a terminal tool would have to refuse to run rather than ` +
          `return an empty result. Check terminal.integrated.shellIntegration.enabled and the default profile.`,
      });
      return results;
    }

    results.push({
      name: "terminal shell integration",
      ok: true,
      detail: `activated after ${activationMs}ms; cwd reported as ${shellIntegration.cwd?.fsPath ?? "(none)"}`,
    });

    const detection = await detectShellFamily(terminal, shellIntegration, log);
    results.push({
      name: "terminal shell family",
      ok: detection.family !== "unsupported" && detection.family !== "unknown",
      detail: `${detection.family} (${detection.source})`,
    });

    if (detection.family === "unsupported" || detection.family === "unknown") {
      results.push({
        name: "terminal probes",
        ok: false,
        detail:
          `skipped: no command dialect for this shell. A terminal tool would have to refuse here ` +
          `rather than emit syntax the shell cannot parse.`,
      });
      return results;
    }

    const family = detection.family;
    results.push(await probeCapture(shellIntegration, family, log));
    results.push(await probeDispatch(shellIntegration, family, log));
    results.push(await probeStreaming(shellIntegration, family, log));
    results.push(await probeExitCode(shellIntegration, family, log));
    results.push(...(await probeUserInput(terminal, shellIntegration, family, log)));

    return results;
  } catch (error) {
    results.push({
      name: "terminal spike",
      ok: false,
      detail: `aborted: ${error instanceof Error ? error.message : String(error)}`,
    });
    return results;
  } finally {
    terminal.dispose();
  }
}

function describeEnvironment(): DiagnosticResult {
  const config = vscode.workspace.getConfiguration("terminal.integrated");
  const enabled = config.get<boolean>("shellIntegration.enabled");
  const profileKey =
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";
  const defaultProfile = config.get<string | null>(`defaultProfile.${profileKey}`);
  return {
    name: "terminal environment",
    ok: enabled !== false,
    detail:
      `vscode ${vscode.version}, platform ${process.platform}, ` +
      `shellIntegration.enabled=${String(enabled)}, defaultProfile.${profileKey}=${defaultProfile ?? "(unset)"}`,
  };
}

function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration);
  return new Promise((resolve) => {
    const settle = (value: vscode.TerminalShellIntegration | undefined) => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(value);
    };
    const timer = setTimeout(() => settle(undefined), timeoutMs);
    const subscription = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal) settle(event.shellIntegration);
    });
  });
}

interface CaptureResult {
  raw: string;
  exitCode: number | undefined;
  exitCodeReported: boolean;
  firstChunkMs: number | undefined;
  /** ms at which each watched marker first appeared in the stream. */
  markerMs: Map<string, number>;
  totalMs: number;
  timedOut: boolean;
}

/**
 * Run one command and capture everything the host will let us see.
 *
 * `read()` is only valid for the lifetime of the execution, so it is started in
 * the same tick as `executeCommand()`. The end event is subscribed *before* the
 * command is issued because `executeCommand()` returns synchronously and the
 * event can, in principle, arrive before the next microtask.
 */
async function runCaptured(
  shellIntegration: vscode.TerminalShellIntegration,
  commandLine: string,
  timeoutMs: number,
  watch: string[] = [],
): Promise<CaptureResult> {
  const startedAt = Date.now();
  let execution: vscode.TerminalShellExecution | undefined;
  let exitCode: number | undefined;
  let exitCodeReported = false;
  let firstChunkMs: number | undefined;
  let raw = "";
  const markerMs = new Map<string, number>();

  let resolveEnd: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnd = resolve;
  });
  const endSubscription = vscode.window.onDidEndTerminalShellExecution((event) => {
    if (execution && event.execution !== execution) return;
    exitCode = event.exitCode;
    exitCodeReported = true;
    resolveEnd();
  });

  try {
    execution = shellIntegration.executeCommand(commandLine);
    const reading = (async () => {
      for await (const chunk of execution.read()) {
        const at = Date.now() - startedAt;
        firstChunkMs ??= at;
        raw += chunk;
        for (const marker of watch) {
          if (!markerMs.has(marker) && raw.includes(marker)) markerMs.set(marker, at);
        }
      }
    })();

    const timedOut = !(await withTimeout(Promise.all([reading, ended]), timeoutMs));
    return {
      raw,
      exitCode,
      exitCodeReported,
      firstChunkMs,
      markerMs,
      totalMs: Date.now() - startedAt,
      timedOut,
    };
  } finally {
    endSubscription.dispose();
  }
}

function withTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(true);
      },
    );
  });
}

/**
 * `TerminalState.shell` is populated asynchronously and is still `undefined`
 * at the moment shell integration activates, so it has to be waited for
 * separately via `onDidChangeTerminalState` rather than read once.
 */
function waitForShellType(terminal: vscode.Terminal, timeoutMs: number): Promise<string | undefined> {
  if (terminal.state.shell) return Promise.resolve(terminal.state.shell);
  return new Promise((resolve) => {
    const settle = (value: string | undefined) => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(value);
    };
    const timer = setTimeout(() => settle(terminal.state.shell), timeoutMs);
    const subscription = vscode.window.onDidChangeTerminalState((changed) => {
      if (changed === terminal && changed.state.shell) settle(changed.state.shell);
    });
  });
}

/**
 * Prefer `TerminalState.shell` (1.99+): it reports a shell *type* from a known
 * set, which distinguishes fish and nu from bash — a distinction the fallback
 * probe below cannot make, and getting it wrong would emit `read -p` into a
 * fish shell and produce a false negative on the probe that decides the design.
 *
 * It can still be `undefined` ("no clear signal"), hence the fallback:
 * `$PSVersionTable` interpolates inside double quotes in PowerShell and expands
 * to nothing in POSIX shells.
 */
async function detectShellFamily(
  terminal: vscode.Terminal,
  shellIntegration: vscode.TerminalShellIntegration,
  log: (message: string) => void,
): Promise<{ family: ShellFamily; source: string }> {
  const reported = await waitForShellType(terminal, SHELL_TYPE_TIMEOUT_MS);
  log(`[shell family] TerminalState.shell=${reported ?? "(undefined)"}`);
  if (reported) {
    return {
      family: SHELL_FAMILIES[reported] ?? "unknown",
      source: `TerminalState.shell=${reported}`,
    };
  }

  const capture = await runCaptured(shellIntegration, 'echo "PISHELL:[$PSVersionTable]"', COMMAND_TIMEOUT_MS);
  log(`[shell family] fallback raw=${JSON.stringify(truncate(capture.raw, 400))}`);
  const match = /PISHELL:\[([^\]]*)\]/.exec(stripSequences(capture.raw));
  if (!match) return { family: "unknown", source: "probe failed" };
  return {
    family: match[1]?.trim() ? "pwsh" : "posix",
    source: "$PSVersionTable probe (shell type unreported)",
  };
}

async function probeCapture(
  shellIntegration: vscode.TerminalShellIntegration,
  dialect: Dialect,
  log: (message: string) => void,
): Promise<DiagnosticResult> {
  const token = `pi-capture-${Date.now().toString(36)}`;
  const command = dialect === "pwsh" ? `Write-Output "${token}"` : `echo "${token}"`;
  const capture = await runCaptured(shellIntegration, command, COMMAND_TIMEOUT_MS);
  const cleaned = stripSequences(capture.raw);
  log(`[capture] raw=${JSON.stringify(truncate(capture.raw, 800))}`);

  const found = cleaned.includes(token);
  const noiseRatio = capture.raw.length === 0 ? 0 : 1 - cleaned.length / capture.raw.length;
  return {
    name: "terminal output capture",
    ok: found && !capture.timedOut,
    detail: found
      ? `echoed token found; ${capture.raw.length}B raw -> ${cleaned.length}B after stripping ` +
        `(${(noiseRatio * 100).toFixed(0)}% control sequences), completed in ${capture.totalMs}ms`
      : `token NOT found in ${capture.raw.length}B of stream${capture.timedOut ? " (timed out)" : ""}; ` +
        `sample: ${JSON.stringify(truncate(capture.raw, 200))}`,
  };
}

/**
 * How long from `executeCommand()` to the first byte, over several trivial
 * commands in a row.
 *
 * The streaming probe first showed ~3.7s before any output while the capture
 * probe completed in 47ms, and those two differ in two ways at once: position in
 * the sequence, and whether the command sleeps. Measuring a series separates a
 * per-command cost (which would dominate every tool call) from a one-off warm-up
 * (which only matters if a terminal is created per call).
 */
async function probeDispatch(
  shellIntegration: vscode.TerminalShellIntegration,
  dialect: Dialect,
  log: (message: string) => void,
): Promise<DiagnosticResult> {
  const samples: number[] = [];
  for (let round = 0; round < 4; round += 1) {
    const marker = `pi-dispatch-${round}`;
    const command = dialect === "pwsh" ? `Write-Output "${marker}"` : `echo "${marker}"`;
    const capture = await runCaptured(shellIntegration, command, COMMAND_TIMEOUT_MS, [marker]);
    samples.push(capture.markerMs.get(marker) ?? capture.totalMs);
  }
  log(`[dispatch] first-byte latencies: ${samples.join(", ")}`);

  // What matters is the steady state: a slow first sample is paid once per
  // terminal, and a tool that keeps one terminal alive pays it once per window.
  const steady = samples.slice(1);
  const worstSteady = steady.length > 0 ? Math.max(...steady) : Number.POSITIVE_INFINITY;
  const warmup = samples[0] ?? 0;
  const series = samples.map((ms) => `${ms}ms`).join(", ");
  return {
    name: "terminal dispatch latency",
    ok: worstSteady < 1000,
    detail:
      worstSteady < 1000
        ? `time to first byte over 4 sequential trivial commands: ${series}. Steady state is under ${worstSteady}ms; ` +
          `any warm-up (${warmup}ms here) is paid once per terminal, so a tool must reuse one terminal rather than ` +
          `create one per call.`
        : `time to first byte over 4 sequential trivial commands: ${series}. The cost persists past the first ` +
          `command, so it is a per-call tax rather than warm-up.`,
  };
}

/**
 * The tool card needs live progress, which requires chunks before the end event.
 *
 * Marker timestamps rather than just first-chunk timing: a uniform shift of the
 * whole stream (dispatch or flush latency) and a genuinely batched delivery look
 * identical from first-chunk alone, and they have opposite implications.
 */
async function probeStreaming(
  shellIntegration: vscode.TerminalShellIntegration,
  dialect: Dialect,
  log: (message: string) => void,
): Promise<DiagnosticResult> {
  const command =
    dialect === "pwsh"
      ? 'Write-Output "pi-stream-a"; Start-Sleep -Seconds 2; Write-Output "pi-stream-b"'
      : "echo pi-stream-a; sleep 2; echo pi-stream-b";
  const capture = await runCaptured(shellIntegration, command, COMMAND_TIMEOUT_MS, [
    "pi-stream-a",
    "pi-stream-b",
  ]);
  const first = capture.firstChunkMs;
  const atA = capture.markerMs.get("pi-stream-a");
  const atB = capture.markerMs.get("pi-stream-b");
  log(`[streaming] firstChunkMs=${first} a=${atA} b=${atB} totalMs=${capture.totalMs}`);

  const timeline = `first chunk ${first ?? "n/a"}ms, "a" ${atA ?? "n/a"}ms, "b" ${atB ?? "n/a"}ms, end ${capture.totalMs}ms`;
  if (atA === undefined || atB === undefined) {
    return { name: "terminal output streaming", ok: false, detail: `markers missing - ${timeline}` };
  }

  // The command sleeps 2s between the two writes. Seeing that gap in the stream
  // is what proves delivery is incremental; `atA` on its own is dispatch cost.
  const gap = atB - atA;
  const streamed = gap > 1000;
  return {
    name: "terminal output streaming",
    ok: streamed,
    detail: streamed
      ? `incremental: ${gap}ms between the two writes (command sleeps 2000ms). ` +
        `Dispatch cost before any output: ${atA}ms. Timeline: ${timeline}`
      : `batched: only ${gap}ms between two writes 2000ms apart, so output lands at the end. Timeline: ${timeline}`,
  };
}

/**
 * PowerShell can only ever report 0 or 1.
 *
 * VS Code's own `shellIntegration.ps1` computes the value it puts in the
 * `OSC 633 ; D ; <code>` sequence as `$FakeCode = [int]!$global:?` — the name
 * is theirs. `shellIntegration-bash.sh` uses `$__vsc_status` (the real `$?`),
 * so POSIX shells do report the true code. A terminal tool must therefore treat
 * the exit code as a boolean on PowerShell hosts and say so in its result text,
 * rather than pass a fabricated `1` to the model as if it were the real code.
 */
async function probeExitCode(
  shellIntegration: vscode.TerminalShellIntegration,
  dialect: Dialect,
  log: (message: string) => void,
): Promise<DiagnosticResult> {
  // Exiting at top level would close the user's shell, so both branches exit a
  // child. `sh -c` rather than `(exit 3)` because fish has no such subshell form.
  const command = dialect === "pwsh" ? "cmd /c exit 3" : 'sh -c "exit 3"';
  const capture = await runCaptured(shellIntegration, command, COMMAND_TIMEOUT_MS);
  log(`[exit code] reported=${capture.exitCodeReported} value=${String(capture.exitCode)}`);

  if (!capture.exitCodeReported) {
    return {
      name: "terminal exit code",
      ok: false,
      detail: "end event never fired, so success/failure cannot be determined",
    };
  }
  if (dialect === "pwsh") {
    return {
      name: "terminal exit code",
      ok: capture.exitCode === 1,
      detail:
        `reported ${String(capture.exitCode)} for a command that exited 3. PowerShell shell integration ` +
        `sends [int]!$? (VS Code calls it $FakeCode), so only success/failure survives — the real code is lost. ` +
        `POSIX shells send the true $?.`,
    };
  }
  return {
    name: "terminal exit code",
    ok: capture.exitCode === 3,
    detail: `reported ${String(capture.exitCode)} (expected 3)`,
  };
}

/**
 * The probe the design hinges on: the user types into the terminal and we check
 * whether their keystrokes come back through `read()`.
 *
 * The instruction lives in the shell prompt itself rather than a modal dialog —
 * a modal would take focus away from the terminal and make it impossible to
 * type, which is also a constraint on the real tool's UI.
 */
async function probeUserInput(
  terminal: vscode.Terminal,
  shellIntegration: vscode.TerminalShellIntegration,
  dialect: Dialect,
  log: (message: string) => void,
): Promise<DiagnosticResult[]> {
  const token = `pi-typed-${Math.random().toString(36).slice(2, 8)}`;
  const prompt = `SPIKE: type ${token} then press Enter`;
  const command =
    dialect === "pwsh"
      ? `$v = Read-Host "${prompt}"; Write-Output "PIGOT:[$v]"`
      : dialect === "fish"
        ? `read -P "${prompt}: " v; echo "PIGOT:[$v]"`
        : `read -p "${prompt}: " v; echo "PIGOT:[$v]"`;

  terminal.show(false);
  void vscode.window.showInformationMessage(`Pi spike: type "${token}" in the "pi spike" terminal, then Enter.`);

  const capture = await runCaptured(shellIntegration, command, INTERACTIVE_TIMEOUT_MS);
  const cleaned = stripSequences(capture.raw);
  const replayed = replayTerminal(capture.raw).text;
  log(`[user input] raw=${JSON.stringify(truncate(capture.raw, 1200))}`);
  log(`[user input] replayed=${JSON.stringify(truncate(replayed, 600))}`);

  if (capture.timedOut) {
    return [
      {
        name: "terminal user input capture",
        ok: false,
        detail: `no answer within ${INTERACTIVE_TIMEOUT_MS}ms (probe skipped or the prompt never appeared)`,
      },
    ];
  }

  // Ground truth is what the shell itself printed back, not the token we asked
  // for: a typo while testing line editing must not read as "capture broken".
  // Read it from the replayed text, which is the candidate for what a real tool
  // would hand the model.
  const shellSaw = /PIGOT:\[([^\]]*)\]/.exec(replayed)?.[1];
  const promptVisible = replayed.includes("SPIKE: type");

  // Both renderings of the echo line, compared against the value the shell
  // actually received. Stripping discards the cursor instructions that told the
  // terminal to overwrite characters, so whatever was overwritten survives;
  // replaying obeys them. Measuring both is the whole point of this probe.
  const echoOf = (text: string): string => {
    const line = text.split("\n").find((candidate) => candidate.includes("Enter:") && !candidate.includes("PIGOT:"));
    if (!line) return "";
    return line.slice(line.indexOf("Enter:") + "Enter:".length).trim();
  };
  const strippedEcho = echoOf(cleaned);
  const replayedEcho = echoOf(replayed);
  const stripOk = shellSaw !== undefined && strippedEcho === shellSaw;
  const replayOk = shellSaw !== undefined && replayedEcho === shellSaw;

  return [
    {
      name: "terminal user input capture",
      ok: shellSaw !== undefined && shellSaw.length > 0,
      detail:
        shellSaw === undefined || shellSaw.length === 0
          ? `the shell never reported a value - sample: ${JSON.stringify(truncate(replayed, 300))}`
          : `prompt in stream: ${promptVisible}; typed characters echoed into stream: ${replayedEcho.length > 0}; ` +
            `shell received ${JSON.stringify(shellSaw)}` +
            (shellSaw === token ? "" : " (differs from the requested token - typed differently, which is fine)"),
    },
    {
      name: "terminal transcript fidelity (strip)",
      ok: stripOk,
      detail: stripOk
        ? `stripping escapes reproduced the received value exactly`
        : `shell received ${JSON.stringify(shellSaw ?? "(unknown)")} but the stripped echo reads ` +
          `${JSON.stringify(truncate(strippedEcho, 200))} - characters that were overwritten on screen survived`,
    },
    {
      name: "terminal transcript fidelity (vt replay)",
      ok: replayOk,
      detail: replayOk
        ? `replaying cursor movements reproduced the received value exactly` +
          (stripOk ? " (no editing happened this run, so both methods agree)" : " where stripping did not")
        : `shell received ${JSON.stringify(shellSaw ?? "(unknown)")} but the replayed echo reads ` +
          `${JSON.stringify(truncate(replayedEcho, 200))}`,
    },
  ];
}

/**
 * Strip the two families of noise that make raw terminal output unusable as a
 * tool result: CSI/OSC escape sequences (colour, cursor moves) and the OSC 633
 * markers VS Code's own shell integration injects.
 *
 * Kept alongside `replayTerminal()` so the spike can report both and show the
 * difference: stripping *discards* cursor instructions instead of obeying them,
 * so any text those instructions overwrote survives as phantom characters.
 */
function stripSequences(text: string): string {
  return text
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-Z\\-_]/g, "")
    .replace(/\r(?!\n)/g, "\n");
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...(+${text.length - limit}B)`;
}


/**
 * Report the shared replay fixtures (`agent/terminal-replay.ts`).
 *
 * Deterministic and terminal-free, so it still reports when every probe below
 * is skipped for want of shell integration. The cases live with the
 * implementation and are also run by `pnpm verify`, so the spike and the
 * shipped tool can never drift apart.
 */
function probeReplayFixture(): DiagnosticResult {
  const failures = findReplayFailures();
  if (failures.length > 0) {
    const first = failures[0] as (typeof failures)[number];
    return {
      name: "terminal vt replay (fixtures)",
      ok: false,
      detail:
        `${failures.length}/${REPLAY_CASES.length} failed; "${first.testCase.name}" produced ` +
        `${JSON.stringify(truncate(first.actual.text, 200))} (cursor line ${first.actual.cursorLine}), expected ` +
        `${JSON.stringify(truncate(first.testCase.expected, 200))}`,
    };
  }
  const capture = REPLAY_CASES[0] as (typeof REPLAY_CASES)[number];
  const strippedFirstLine = stripSequences(capture.raw).split("\n")[0] ?? "";
  return {
    name: "terminal vt replay (fixtures)",
    ok: true,
    detail:
      `${REPLAY_CASES.length}/${REPLAY_CASES.length} replay exactly. On the recorded paste-and-redraw capture, ` +
      `stripping the same bytes instead yields ${JSON.stringify(truncate(strippedFirstLine, 120))}`,
  };
}
