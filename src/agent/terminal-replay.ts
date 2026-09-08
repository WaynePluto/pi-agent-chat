/**
 * 迷你 VT 重放：遵从光标指令而不是剥离它们。范围刻意是「行编辑与简单
 * 重绘」：shell 行编辑在退格、粘贴、方向键与历史回溯时重定位光标并
 * 覆写字符，进度条靠回车重绘；全屏程序（vim、htop）需要真模拟器。
 *
 * 剥离转义序列对交给模型的文本不可行：它丢弃了告诉终端覆写哪些字符的
 * 指令，被覆写的内容以幻影文本幸存（spike 实测：一次退格就让
 * `pi-typed-qf8j0ggg` 多出 `  ^V   g`），本模块因此存在并被
 * `scripts/check_terminal_replay.mjs` 钉住。
 */

/** 一次重放出的屏幕：终端此刻会显示什么，以及光标在哪。 */
export interface TerminalScreen {
  /** 渲染出的行，去尾随空白，首尾空行丢弃。 */
  lines: string[];
  /**
   * 光标最终停在 {@link lines} 中的行下标；停在最后一个渲染行之后时
   * 为 `lines.length`。
   *
   * 这是增量续读的边界。它之前的行已定；光标行本身仍在被画
   * （进度条每次更新都重写它），读取方必须每次重发该行而不是当成新
   * 内容——否则一次 `npm install` 每次重绘都产出一个新「行」，而靠
   * 「行数变短了」识别重绘又会把整屏重发一遍。
   */
  cursorLine: number;
  /** 合并文本：`lines.join("\n")`。 */
  text: string;
}

/**
 * 把 `data` 重放到稀疏屏幕上，返回它会显示的内容。
 *
 * 屏幕是行映射而非矩形，因此无需假设终端宽度。绝对原点未知（采集从
 * 屏幕中途开始），由第一个绝对光标移动学得：行编辑器总会发一个到
 * 自己已在位置的光标移动，那让它成为可靠的锚点。
 */
export function replayTerminal(data: string): TerminalScreen {
  const rows = new Map<number, string[]>();
  let row = 0;
  let col = 0;
  let originRow: number | undefined;

  const cellsAt = (key: number): string[] => {
    let cells = rows.get(key);
    if (!cells) {
      cells = [];
      rows.set(key, cells);
    }
    return cells;
  };
  const write = (char: string) => {
    const cells = cellsAt(row);
    while (cells.length < col) cells.push(" ");
    cells[col] = char;
    col += 1;
  };
  const numbers = (params: string, fallback: number): number[] =>
    params.split(";").map((part) => (part === "" ? fallback : Number.parseInt(part, 10) || fallback));

  const applyCsi = (final: string | undefined, params: string): void => {
    const cells = () => cellsAt(row);
    switch (final) {
      case "H":
      case "f": {
        const [targetRow = 1, targetCol = 1] = numbers(params, 1);
        originRow ??= targetRow - row;
        row = Math.max(0, targetRow - originRow);
        col = Math.max(0, targetCol - 1);
        break;
      }
      case "d": {
        const [targetRow = 1] = numbers(params, 1);
        originRow ??= targetRow - row;
        row = Math.max(0, targetRow - originRow);
        break;
      }
      case "A":
        row = Math.max(0, row - (numbers(params, 1)[0] ?? 1));
        break;
      case "B":
        row += numbers(params, 1)[0] ?? 1;
        break;
      case "C":
        col += numbers(params, 1)[0] ?? 1;
        break;
      case "D":
        col = Math.max(0, col - (numbers(params, 1)[0] ?? 1));
        break;
      case "G":
        col = Math.max(0, (numbers(params, 1)[0] ?? 1) - 1);
        break;
      case "K": {
        const mode = numbers(params, 0)[0] ?? 0;
        const line = cells();
        if (mode === 0) line.length = Math.min(line.length, col);
        else if (mode === 1) for (let i = 0; i <= col && i < line.length; i += 1) line[i] = " ";
        else line.length = 0;
        break;
      }
      case "J": {
        const mode = numbers(params, 0)[0] ?? 0;
        if (mode === 0) {
          const line = cells();
          line.length = Math.min(line.length, col);
          for (const key of [...rows.keys()]) if (key > row) rows.delete(key);
        } else {
          rows.clear();
        }
        break;
      }
      case "P":
        cells().splice(col, numbers(params, 1)[0] ?? 1);
        break;
      case "@":
        cells().splice(col, 0, ...Array<string>(numbers(params, 1)[0] ?? 1).fill(" "));
        break;
      case "X": {
        const count = numbers(params, 1)[0] ?? 1;
        const line = cells();
        while (line.length < col) line.push(" ");
        for (let i = 0; i < count; i += 1) line[col + i] = " ";
        break;
      }
      default:
        // SGR（`m`）、设备状态回报（`n`）、模式变更等其余序列，
        // 对我们的目的不改动任何单元格内容。
        break;
    }
  };

  let index = 0;
  while (index < data.length) {
    const char = data[index] as string;

    if (char === "\u001B") {
      const next = data[index + 1];
      if (next === "[") {
        let end = index + 2;
        while (end < data.length && /[0-9;?]/.test(data[end] as string)) end += 1;
        while (end < data.length && /[ -/]/.test(data[end] as string)) end += 1;
        const final = data[end];
        const params = data.slice(index + 2, end).replace(/\?/g, "");
        index = end + 1;
        applyCsi(final, params);
        continue;
      }
      if (next === "]") {
        // OSC 直到 BEL 或 String Terminator 才结束。VS Code 自己的
        // shell integration 标记（OSC 633）也是这样离开 transcript 的。
        let end = index + 2;
        while (end < data.length && data[end] !== "\u0007" && !(data[end] === "\u001B" && data[end + 1] === "\\")) {
          end += 1;
        }
        index = data[end] === "\u0007" ? end + 1 : end + 2;
        continue;
      }
      index += 2;
      continue;
    }

    index += 1;
    if (char === "\r") col = 0;
    else if (char === "\n") row += 1;
    else if (char === "\b") col = Math.max(0, col - 1);
    else if (char === "\t") col += 8 - (col % 8);
    else if (char >= " ") write(char);
    // 其余 C0 控制符（BEL 等）既不移动也不打印。
  }

  const keys = [...rows.keys()].sort((a, b) => a - b);
  const lines = keys.map((key) =>
    (rows.get(key) ?? [])
      .map((cell) => cell ?? " ")
      .join("")
      .replace(/\s+$/, ""),
  );
  // 光标落在渲染行中的位置：它上方的行数。行是稀疏的，光标停在一个
  // 从未写过的行上时落在插入点，那是同一个答案。
  let cursorLine = keys.filter((key) => key < row).length;

  let leading = 0;
  while (leading < lines.length && lines[leading] === "") leading += 1;
  lines.splice(0, leading);
  cursorLine -= leading;
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  cursorLine = Math.min(Math.max(cursorLine, 0), lines.length);

  return { lines, cursorLine, text: lines.join("\n") };
}

/** 一条重放期望，由 spike 与 `pnpm verify` 检查。 */
export interface ReplayCase {
  name: string;
  raw: string;
  expected: string;
  /** 期望的光标行，钉住增量续读边界的用例才填。 */
  expectedCursorLine?: number;
}

/**
 * 重放用例：无终端、无人参与也照常检查，因此缺 shell integration
 * 而跳过其余项目时它们仍在报告。
 *
 * 第一条是 spike 一次真实采集，用户在当中粘贴过——终端回显了 `^V`、
 * 擦掉、再重画整行。它记录问题实际的样子；其余覆盖终端覆写既有输出
 * 的其他方式。
 */
export const REPLAY_CASES: readonly ReplayCase[] = [
  {
    name: "paste + redraw (real capture)",
    raw:
      "\u001b]633;C\u0007SPIKE: type pi-typed-mtzuen then press Enter: " +
      "\u001b[14;47H^V\u001b[14;49H\u001b[14;47H  \u001b[14;47H" +
      "\u001b[14;47H^V\u001b[14;49H\u001b[14;47H  \u001b[14;47H" +
      "\u001b[14;47Hpi-typed-mtzuen\u001b[14;62H\u001b[14;62H\r\n" +
      "\u001b[6n\u001b[15;1HPIGOT:[pi-typed-mtzuen]\r\n",
    expected: "SPIKE: type pi-typed-mtzuen then press Enter: pi-typed-mtzuen\nPIGOT:[pi-typed-mtzuen]",
    // 两行都已结束：光标停在最后一行的下一行。
    expectedCursorLine: 2,
  },
  { name: "backspace", raw: "abcX\b \bd", expected: "abcd", expectedCursorLine: 0 },
  {
    name: "carriage-return progress bar",
    raw: "10%\r50%\r100% done",
    expected: "100% done",
    // 被重绘的行就是光标所在行，增量读取因此不断重发它，
    // 而不是把每次重绘当成新行上报。
    expectedCursorLine: 0,
  },
  { name: "erase in line", raw: "hello world\u001b[6D\u001b[K", expected: "hello" },
  { name: "delete characters", raw: "abcXYdef\u001b[8D\u001b[3C\u001b[2P", expected: "abcdef" },
  { name: "colour is not content", raw: "\u001b[31mred\u001b[0m", expected: "red" },
  { name: "redraw shorter line", raw: "longvalue\r\u001b[Kab", expected: "ab" },
  {
    name: "settled rows precede the cursor",
    raw: "first\r\nsecond\r\nthir",
    expected: "first\nsecond\nthir",
    // 两行已定，第三行仍在输入中。
    expectedCursorLine: 2,
  },
];

/** 跑全部用例；返回重放不匹配的那些。 */
export function findReplayFailures(): { testCase: ReplayCase; actual: TerminalScreen }[] {
  const failures: { testCase: ReplayCase; actual: TerminalScreen }[] = [];
  for (const testCase of REPLAY_CASES) {
    const actual = replayTerminal(testCase.raw);
    const cursorOk = testCase.expectedCursorLine === undefined || actual.cursorLine === testCase.expectedCursorLine;
    if (actual.text !== testCase.expected || !cursorOk) failures.push({ testCase, actual });
  }
  return failures;
}
