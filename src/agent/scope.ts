import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * 子代理的可写范围。
 *
 * 范围是相对会话 cwd 的**路径前缀**——一个目录或单个文件——不是 glob。
 * 这是刻意的：整个设计立在「开跑前证明两个子代理碰不到同一个文件」
 * 之上，而任意两个 glob 是否相交一般不可判定，glob 形状的 API 会把重叠
 * 检查悄悄降级成猜——猜正是 `scope` 要消除的东西。前缀白送两个性质：
 * 包含判定是字符串比较；两范围相交当且仅当其一包含另一个。
 */

/** 已规范化的、相对 cwd 的路径前缀。空串表示整棵树。 */
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
 * 把一条声明的范围对 cwd 规范化。
 *
 * 返回正斜杠、无尾分隔符的相对前缀；范围越出工作树时抛错——能声明
 * `../` 的子代理会让重叠检查失去意义。
 */
export function normalizeScope(cwd: string, range: string): ScopePrefix {
  const trimmed = range.trim();
  if (!trimmed) throw new Error("A scope entry cannot be empty");
  // 容忍人们下意识写的 glob 后缀；在这里它与裸目录同义。
  const withoutGlob = trimmed.replace(/[\\/]\*\*?$/, "").replace(/^\.[\\/]/, "");
  const absolute = isAbsolute(withoutGlob) ? resolve(withoutGlob) : resolve(cwd, withoutGlob);
  const rel = relative(resolve(cwd), absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Scope '${range}' points outside the working directory`);
  }
  return rel.split(sep).join("/");
}

/**
 * 规范化一个子代理的全部范围，并拒绝其中的重复项。
 *
 * 空列表合法，含义是「不写任何东西」：只需要读或跑命令的任务应该照实
 * 说，而不是被逼着编一个它根本不会碰的目录。
 */
export function normalizeScopes(cwd: string, ranges: readonly string[]): ScopePrefix[] {
  const seen = new Set<ScopePrefix>();
  for (const range of ranges) seen.add(normalizeScope(cwd, range));
  return [...seen];
}

/** `prefix` 是否包含 `candidate`（均已规范化，允许相等）。 */
function contains(prefix: ScopePrefix, candidate: ScopePrefix): boolean {
  if (prefix === "") return true;
  if (candidate === prefix) return true;
  return candidate.startsWith(`${prefix}/`);
}

/** 两个范围是否可能指到同一个文件。 */
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
 * 找出第一对可写范围相交的子代理。
 *
 * 在任何子代理启动前运行：范围重叠意味着两者可能并发改同一个文件，
 * 而事后没有回滚，那样的损伤就是永久的。
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
 * 强制单个子代理的可写范围，并记录它实际写过什么。
 *
 * 记账不是可有可无的附带品：失败只汇报不回滚，父代理只有在被告知每路
 * 停下前碰过哪些文件时，才能判断工作树的状态。
 */
export class ScopeGuard {
  /**
   * 每个子代理保留的被拒路径（去重）。
   *
   * 设上限是因为反复重试同一被禁写入的循环不能无限撑大汇报；
   * 下面的计数保持精确。
   */
  private static readonly MAX_DENIED = 20;

  private readonly written = new Set<string>();
  private readonly denied = new Set<string>();
  private violations = 0;

  constructor(
    private readonly cwd: string,
    readonly scope: readonly ScopePrefix[],
  ) {}

  /** 到目前为止写过的文件，相对 cwd，按首次写入排序。 */
  get writtenFiles(): string[] {
    return [...this.written];
  }

  /**
   * 该子代理试图写而被拒的文件，按首次尝试排序。
   *
   * 只有计数说明切分错了；路径才说明*错在哪*。一次拒绝是父代理对自己
   * 子代理没做完的工作的唯一痕迹——典型如跨切面的改动（重命名并更新
   * 调用方）——有了路径，父代理才能自己收尾或重新切分，而不是猜缺什么。
   */
  get deniedPaths(): string[] {
    return [...this.denied];
  }

  /**
   * 因越出声明范围被拒的写入次数。
   *
   * 子代理最终成功也照常汇报：一次拒绝意味着父代理对工作的切分与任务
   * 实际需要不符，那是下一次尝试最有用的信号。
   */
  get violationCount(): number {
    return this.violations;
  }

  /** 除非 `absolutePath` 落在某个声明范围内，否则抛错。 */
  assertWritable(absolutePath: string): string {
    const rel = relative(resolve(this.cwd), resolve(absolutePath)).split(sep).join("/");
    if (rel.startsWith("..") || isAbsolute(rel)) this.refuse(absolutePath);
    if (!this.scope.some((prefix) => contains(prefix, rel))) this.refuse(rel);
    return rel;
  }

  /** 记下这次拒绝，然后以错误形式报给调用方。 */
  private refuse(path: string): never {
    this.violations++;
    if (this.denied.size < ScopeGuard.MAX_DENIED) this.denied.add(path);
    throw new OutOfScopeError({ path, scope: this.scope });
  }

  /** 先检查再记账；由写工具的文件操作层调用。 */
  recordWrite(absolutePath: string): void {
    this.written.add(this.assertWritable(absolutePath));
  }
}
