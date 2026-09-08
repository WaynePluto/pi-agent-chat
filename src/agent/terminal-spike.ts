import * as vscode from "vscode";
import type { DiagnosticResult } from "./diagnostics.js";
import { findReplayFailures, replayTerminal, REPLAY_CASES } from "./terminal-replay.js";

/**
 * 提案中 `terminal` 工具的真机探针（VS Code 集成终端作为用户可键入的
 * 命令执行表面）。刻意不进 `runSpikeDiagnostics()`：那套无头对着桩掉的
 * `vscode` 模块跑，而这里需要真窗口、真 shell、键盘前的真人。
 *
 * 三个 go/no-go 问题：① `shellIntegration` 会不会激活、要多久——没有
 * 它就读不回输出，只会重现扩展式 `subagent` 的 exit 0 + 空输出；
 * ② `read()` 会不会包含用户敲的字——击键不进流，agent 就无从知道发生
 * 了什么；③ `exitCode` 到底报不报。其余测量项供决策的成本侧。
 */

const ACTIVATION_TIMEOUT_MS = 10_000;
const SHELL_TYPE_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 15_000;
const INTERACTIVE_TIMEOUT_MS = 90_000;

/**
 * 命令语法的家族。比 `TerminalState.shell` 更粗，探针只需要知道该说
 * 哪种方言；但 `unsupported` 与 `unknown` 是不同结果：前者是明确的
 * 「这里什么都别跑」，后者是「猜一个并如实报告低置信度」。
 */
type ShellFamily = "pwsh" | "posix" | "fish" | "unsupported" | "unknown";

/** 有探针可发出的命令方言的子集。 */
type Dialect = "pwsh" | "posix" | "fish";

/** 文档列出的 `TerminalState.shell` 取值，映射到方言。 */
const SHELL_FAMILIES: Record<string, ShellFamily> = {
  bash: "posix",
  gitbash: "posix",
  wsl: "posix",
  zsh: "posix",
  ksh: "posix",
  sh: "posix",
  fish: "fish",
  pwsh: "pwsh",
  // cmd 永远没有 shell integration；csh 没有 `read -p`；其余是恰好
  // 跑在终端里的 REPL，不是拿来跑命令的 shell。
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
  // 确定性且无需终端，下面全因缺 shell integration 被跳过时它仍在报告。
  results.push(probeReplayFixture());
  const terminal = vscode.window.createTerminal({
    name: "pi spike",
    cwd,
    // 终端销毁后不留进用户的终端历史。
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
  /** 各观察标记首次出现在流中的毫秒时刻。 */
  markerMs: Map<string, number>;
  totalMs: number;
  timedOut: boolean;
}

/**
 * 跑一条命令并捕获宿主肯让我们看到的一切。
 *
 * `read()` 只在 execution 的生命周期内有效，因此与 `executeCommand()`
 * 同一个 tick 启动。结束事件在发命令*之前*订阅：`executeCommand()` 同步
 * 返回，事件原则上可能在下一个微任务之前就到。
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
 * `TerminalState.shell` 是异步填充的，shell integration 激活那一刻仍是
 * `undefined`，所以得经 `onDidChangeTerminalState` 另等，不能读一次
 * 了事。
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
 * 优先用 `TerminalState.shell`（1.99+）：它报已知集合里的 shell *类型*，
 * 能区分 fish 与 nu 跟 bash——下面的兜底探针做不出这个区分，分错了会
 * 往 fish 里发 `read -p`，让决定设计的探针产出假阴性。
 *
 * 它仍可能是 `undefined`（「没有明确信号」），故有兜底：
 * `$PSVersionTable` 在 PowerShell 的双引号里插值，在 POSIX shell 里
 * 展开为空。
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
 * 从 `executeCommand()` 到首个字节的耗时，连跑几条琐碎命令。
 *
 * 流式探针先测出任何输出前约 3.7s，而捕获探针 47ms 就完成，两者同时
 * 差在两点：序列里的位置、命令是否睡眠。测一串才能把「每条命令的
 * 固定开销」（会主导每次工具调用）与「一次性预热」（只在每次调用都
 * 新建终端时才要紧）分开。
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

  // 要紧的是稳态：首个样本慢只是每终端付一次，保活终端的工具每个
  // 窗口付一次。
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
 * 工具卡片需要实时进展，也就是结束事件之前就要有分块。
 *
 * 用标记时间戳而非只测首块：整条流的均匀平移（派发或 flush 延迟）与
 * 真正攒批送达，只看首块完全同貌，而两者的含义相反。
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

  // 命令在两次输出间睡 2s。流里看得到那个间隔才证明交付是增量的；
  // `atA` 自己只是派发成本。
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
 * PowerShell 最多只能报出 0 或 1。
 *
 * VS Code 自带的 `shellIntegration.ps1` 放进 `OSC 633 ; D ; <code>` 的
 * 值是 `$FakeCode = [int]!$global:?`——这名字是它起的。
 * `shellIntegration-bash.sh` 用的是 `$__vsc_status`（真 `$?`），所以
 * POSIX shell 报真码。终端工具因此必须把 PowerShell 宿主的退出码当
 * 布尔用、并在结果文本里说明，而不是把编造的 `1` 当真码交给模型。
 */
async function probeExitCode(
  shellIntegration: vscode.TerminalShellIntegration,
  dialect: Dialect,
  log: (message: string) => void,
): Promise<DiagnosticResult> {
  // 顶层 exit 会关掉用户的 shell，两个分支都退子进程。用 `sh -c` 而非
  // `(exit 3)`，因为 fish 没有后一种子 shell 形式。
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
 * 设计系于此的探针：用户往终端里打字，我们检查击键是否经 `read()`
 * 回来。
 *
 * 指令放在 shell prompt 本身而非模态对话框——模态会把焦点从终端拿走、
 * 让人没法打字，这也是对真工具 UI 的约束。
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

  // 真值是 shell 自己回显的内容，不是我们请求的 token：测试行编辑时
  // 打错字不该读成「捕获坏了」。从重放文本里读——那正是真工具会交给
  // 模型的候选。
  const shellSaw = /PIGOT:\[([^\]]*)\]/.exec(replayed)?.[1];
  const promptVisible = replayed.includes("SPIKE: type");

  // 回显行的两种渲染，与 shell 实际收到的值比对。剥离丢弃了告诉终端
  // 覆写哪些字符的光标指令，被覆写的字符因此幸存；重放则遵从它们。
  // 两个都量，正是本探针的全部意义。
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
 * 剥掉让原始终端输出没法当工具结果的两大族噪声：CSI/OSC 转义序列
 * （颜色、光标移动）与 VS Code 自己注入的 OSC 633 标记。
 *
 * 与 `replayTerminal()` 放在一起，spike 才能两个都报、摆出差别：剥离
 * *丢弃*光标指令而不是遵从它，被指令覆写的文本就以幻影字符幸存。
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
 * 报告共享的重放用例（`agent/terminal-replay.ts`）。
 *
 * 确定性且无需终端，下面每个探针都因缺 shell integration 被跳过时它
 * 仍在报告。用例与实现同居、也由 `pnpm verify` 跑，spike 与线上工具
 * 因此永不漂移。
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
