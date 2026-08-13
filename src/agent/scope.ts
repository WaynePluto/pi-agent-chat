import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Write ranges for subagents.
 *
 * A range is a **path prefix** relative to the session cwd — a directory or a
 * single file — not a glob. That restriction is deliberate: the whole design
 * rests on being able to prove, before anything runs, that two subagents cannot
 * touch the same file. Deciding whether two arbitrary globs intersect is not
 * tractable in general, so a glob-shaped API would quietly turn the overlap
 * check into a guess, and a guess is exactly what `scope` exists to remove.
 *
 * Prefixes give both properties for free: containment is a string comparison,
 * and two ranges overlap iff one contains the other.
 */

/** A normalized, cwd-relative path prefix. Empty string means the whole tree. */
export type ScopePrefix = string;

export interface ScopeViolation {
  readonly path: string;
  readonly scope: readonly ScopePrefix[];
}

export class OutOfScopeError extends Error {
  constructor(readonly violation: ScopeViolation) {
    const ranges = violation.scope.length > 0 ? violation.scope.map((s) => `'${s}'`).join(", ") : "(read-only)";
    super(
      `Refused to write ${violation.path}: outside this subagent's declared scope (${ranges}). ` +
        `Report what you could not do instead; the parent agent will decide how to proceed.`,
    );
    this.name = "OutOfScopeError";
  }
}

/**
 * Normalize one declared range against a cwd.
 *
 * Returns a cwd-relative prefix with forward slashes and no trailing separator.
 * Throws when the range escapes the working tree — a subagent that could
 * declare `../` would make the overlap check meaningless.
 */
export function normalizeScope(cwd: string, range: string): ScopePrefix {
  const trimmed = range.trim();
  if (!trimmed) throw new Error("A scope entry cannot be empty");
  // Tolerate the glob suffix people reflexively write; it means the same thing
  // as the bare directory here.
  const withoutGlob = trimmed.replace(/[\\/]\*\*?$/, "").replace(/^\.[\\/]/, "");
  const absolute = isAbsolute(withoutGlob) ? resolve(withoutGlob) : resolve(cwd, withoutGlob);
  const rel = relative(resolve(cwd), absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Scope '${range}' points outside the working directory`);
  }
  return rel.split(sep).join("/");
}

/**
 * Normalize every range of one subagent, rejecting duplicates within it.
 *
 * An empty list is valid and means "writes nothing": a task that only needs to
 * read or run commands should say so, rather than being pushed into inventing a
 * directory it will never touch.
 */
export function normalizeScopes(cwd: string, ranges: readonly string[]): ScopePrefix[] {
  const seen = new Set<ScopePrefix>();
  for (const range of ranges) seen.add(normalizeScope(cwd, range));
  return [...seen];
}

/** Whether `prefix` contains `candidate` (both normalized, `candidate` may equal it). */
function contains(prefix: ScopePrefix, candidate: ScopePrefix): boolean {
  if (prefix === "") return true;
  if (candidate === prefix) return true;
  return candidate.startsWith(`${prefix}/`);
}

/** Whether two ranges can ever refer to the same file. */
export function overlaps(a: ScopePrefix, b: ScopePrefix): boolean {
  return contains(a, b) || contains(b, a);
}

export interface ScopeConflict {
  readonly firstIndex: number;
  readonly secondIndex: number;
  readonly firstScope: ScopePrefix;
  readonly secondScope: ScopePrefix;
}

/**
 * Find the first pair of subagents whose write ranges intersect.
 *
 * Run before any child starts: overlapping ranges mean the two of them could
 * edit one file concurrently, and since nothing is rolled back afterwards that
 * damage would be permanent.
 */
export function findScopeConflict(scopes: readonly (readonly ScopePrefix[])[]): ScopeConflict | undefined {
  for (let i = 0; i < scopes.length; i++) {
    for (let j = i + 1; j < scopes.length; j++) {
      for (const first of scopes[i] ?? []) {
        for (const second of scopes[j] ?? []) {
          if (overlaps(first, second)) {
            return { firstIndex: i, secondIndex: j, firstScope: first, secondScope: second };
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Enforces one subagent's write ranges and records what it actually wrote.
 *
 * The recording half is not optional bookkeeping: failures are reported rather
 * than rolled back, so the parent agent can only judge the state of the working
 * tree if it is told which files each lane touched before it stopped.
 */
export class ScopeGuard {
  /**
   * Distinct refused paths kept per subagent.
   *
   * Capped because a loop that keeps retrying one forbidden write must not be
   * able to grow the report without bound; the count below stays exact.
   */
  private static readonly MAX_DENIED = 20;

  private readonly written = new Set<string>();
  private readonly denied = new Set<string>();
  private violations = 0;

  constructor(
    private readonly cwd: string,
    readonly scope: readonly ScopePrefix[],
  ) {}

  /** Files written so far, cwd-relative, in first-write order. */
  get writtenFiles(): string[] {
    return [...this.written];
  }

  /**
   * Files this subagent tried to write and was refused, in first-attempt order.
   *
   * The count alone says the split was wrong; these say *where*. A refusal is
   * the parent's only trace of work its child could not do -- typically a
   * change that spans ranges, such as renaming something and updating its
   * callers -- so the paths are what let the parent finish the job itself or
   * re-split it, instead of guessing what is missing.
   */
  get deniedPaths(): string[] {
    return [...this.denied];
  }

  /**
   * How many writes were refused for leaving the declared range.
   *
   * Reported even when the subagent goes on to succeed: a refusal means the
   * parent's split of the work did not match what the task actually needed,
   * which is the single most useful signal for the next attempt.
   */
  get violationCount(): number {
    return this.violations;
  }

  /** Throw unless `absolutePath` falls inside one of the declared ranges. */
  assertWritable(absolutePath: string): string {
    const rel = relative(resolve(this.cwd), resolve(absolutePath)).split(sep).join("/");
    if (rel.startsWith("..") || isAbsolute(rel)) this.refuse(absolutePath);
    if (!this.scope.some((prefix) => contains(prefix, rel))) this.refuse(rel);
    return rel;
  }

  /** Record the refusal, then report it to the caller as an error. */
  private refuse(path: string): never {
    this.violations++;
    if (this.denied.size < ScopeGuard.MAX_DENIED) this.denied.add(path);
    throw new OutOfScopeError({ path, scope: this.scope });
  }

  /** Check, then record. Call from the file-operation layer of a write tool. */
  recordWrite(absolutePath: string): void {
    this.written.add(this.assertWritable(absolutePath));
  }
}
