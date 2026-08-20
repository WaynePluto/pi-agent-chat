/**
 * Minimal VT replay: obey the cursor operations instead of deleting them.
 *
 * Scope is deliberately "line editing and simple redraws", not a terminal
 * emulator. That is the noise a command-running tool actually meets: the
 * shell's line editor repositions the cursor and overwrites characters on
 * every backspace, paste, arrow key and history recall, and progress bars
 * redraw with carriage returns. Full-screen programs (vim, htop) are out of
 * scope — they need a real emulator with an alternate screen buffer, scroll
 * regions and a known width, and they are not what a transcript-centred tool
 * is for.
 *
 * Stripping escape sequences instead — the obvious alternative — is not an
 * option for text handed to a model: it *discards* the instructions that told
 * the terminal to overwrite characters, so whatever was overwritten survives
 * as phantom text. The spike measured exactly that (a single backspace turned
 * `pi-typed-qf8j0ggg` into `pi-typed-qf8j0ggg  ^V   g`), which is why this
 * module exists and why `scripts/check_terminal_replay.mjs` pins it: it is the
 * only part of the terminal tool with real logic, and it regresses silently.
 */

/** A replayed screen: what the terminal would be showing, plus where the cursor is. */
export interface TerminalScreen {
  /**
   * Rendered rows, trailing whitespace removed, with leading and trailing
   * blank rows dropped.
   */
  lines: string[];
  /**
   * Index into {@link lines} of the row the cursor ended on, or `lines.length`
   * when it ended past the last rendered row.
   *
   * This is the boundary incremental reads use. Rows *before* it are settled;
   * the cursor row itself is still being drawn (a progress bar rewrites it on
   * every update), so a reader must re-send that row each time rather than
   * treat it as new content — otherwise a single `npm install` produces a
   * fresh "line" per repaint, and detecting the repaint by "the line count
   * shrank" would re-send the whole screen instead.
   */
  cursorLine: number;
  /** `lines.join("\n")`. */
  text: string;
}

/**
 * Replay `data` onto a sparse screen and return what it would show.
 *
 * The screen is a map of rows rather than a rectangle, so no terminal width
 * has to be assumed. The absolute origin is unknown because capture starts
 * mid-screen, so it is learned from the first absolute cursor move: line
 * editors emit one to the position they are already at, which makes that first
 * move a reliable anchor.
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
        // SGR (`m`), device status reports (`n`), mode changes and everything
        // else alter no cell contents for our purposes.
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
        // OSC runs until BEL or String Terminator. This is also how VS Code's
        // own shell integration markers (OSC 633) leave the transcript.
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
    // Remaining C0 controls (BEL and friends) move nothing and print nothing.
  }

  const keys = [...rows.keys()].sort((a, b) => a - b);
  const lines = keys.map((key) =>
    (rows.get(key) ?? [])
      .map((cell) => cell ?? " ")
      .join("")
      .replace(/\s+$/, ""),
  );
  // Where the cursor sits among the rendered rows: the number of rows above it.
  // Rows are sparse, so a cursor on a row nothing was ever written to lands on
  // the insertion point, which is the same answer.
  let cursorLine = keys.filter((key) => key < row).length;

  let leading = 0;
  while (leading < lines.length && lines[leading] === "") leading += 1;
  lines.splice(0, leading);
  cursorLine -= leading;
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  cursorLine = Math.min(Math.max(cursorLine, 0), lines.length);

  return { lines, cursorLine, text: lines.join("\n") };
}

/** One replay expectation, checked by the spike and by `pnpm verify`. */
export interface ReplayCase {
  name: string;
  raw: string;
  expected: string;
  /** Expected cursor row, where a case pins the incremental-read boundary. */
  expectedCursorLine?: number;
}

/**
 * Replay cases, checked with no terminal and no human so they still report
 * when everything else is skipped for want of shell integration.
 *
 * The first is a real capture from a spike run in which the user pasted — so
 * the terminal echoed `^V`, erased it, and redrew the line. It records what
 * the problem actually looked like; the rest cover the other ways a terminal
 * overwrites what it already printed.
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
    // Both rows are finished: the cursor ended on the row after the last one.
    expectedCursorLine: 2,
  },
  { name: "backspace", raw: "abcX\b \bd", expected: "abcd", expectedCursorLine: 0 },
  {
    name: "carriage-return progress bar",
    raw: "10%\r50%\r100% done",
    expected: "100% done",
    // The redrawn row is where the cursor is, so an incremental reader keeps
    // re-sending it instead of reporting each repaint as a new line.
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
    // Two settled rows, and a third still being typed into.
    expectedCursorLine: 2,
  },
];

/** Run every case; returns the ones whose replay does not match. */
export function findReplayFailures(): { testCase: ReplayCase; actual: TerminalScreen }[] {
  const failures: { testCase: ReplayCase; actual: TerminalScreen }[] = [];
  for (const testCase of REPLAY_CASES) {
    const actual = replayTerminal(testCase.raw);
    const cursorOk = testCase.expectedCursorLine === undefined || actual.cursorLine === testCase.expectedCursorLine;
    if (actual.text !== testCase.expected || !cursorOk) failures.push({ testCase, actual });
  }
  return failures;
}
