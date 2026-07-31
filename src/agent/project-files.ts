import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ProjectFileItem } from "../shared/protocol.js";

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 5_000;
const MAX_INDEX_FILES = 20_000;
export const MAX_FILE_REFERENCES = 10;

const BINARY_EXTENSIONS = new Set([
  ".7z", ".a", ".avi", ".bin", ".bmp", ".class", ".dll", ".dylib", ".exe", ".flac", ".gif", ".gz",
  ".ico", ".jar", ".jpeg", ".jpg", ".lib", ".mov", ".mp3", ".mp4", ".o", ".obj", ".pdf", ".png",
  ".so", ".tar", ".tiff", ".ttf", ".wav", ".webm", ".webp", ".woff", ".woff2", ".xz", ".zip",
]);

const SENSITIVE_NAMES = new Set([
  ".env", ".env.local", ".npmrc", ".pypirc", "auth.json", "credentials.json", "id_dsa", "id_ed25519", "id_rsa",
]);

/** Bulk vendor/build directories that are never searchable, even with "show ignored" on. */
const EXCLUDED_DIRS = new Set([
  ".git", "node_modules", "bower_components", "vendor", ".venv", "venv", "__pycache__",
  ".pnpm-store", ".yarn", ".gradle", ".tox", ".mypy_cache", ".pytest_cache", "target",
  "dist", "out", "build", ".next", ".nuxt", ".cache",
]);

function isExcludedPath(path: string): boolean {
  return path.split("/").some((segment) => EXCLUDED_DIRS.has(segment.toLowerCase()));
}

interface FileIndex {
  createdAt: number;
  regular: string[];
  ignored: string[];
}

export interface ValidatedProjectFiles {
  paths: string[];
  ignored: string[];
  sensitive: string[];
}

/** Project file discovery for the webview's @ picker. */
export class ProjectFileIndex {
  private readonly cache = new Map<string, FileIndex>();

  constructor(private readonly log: (message: string) => void) {}

  async search(cwd: string, query: string, includeIgnored: boolean, maxResults = 100): Promise<ProjectFileItem[]> {
    const index = await this.load(cwd);
    const ignoredSet = new Set(index.ignored);
    // Bulk directories (node_modules etc.) are never searchable, regardless of
    // the "show ignored" toggle; git-tracked files are exempt from this rule.
    const selected = includeIgnored
      ? [...index.regular, ...index.ignored.filter((path) => !isExcludedPath(path))]
      : index.regular;
    return selected
      .filter((path, position, all) => all.indexOf(path) === position)
      .filter((path) => !isKnownBinary(path))
      .map((path) => ({ path, ignored: ignoredSet.has(path), sensitive: isSensitive(path), score: scorePath(path, query) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, maxResults)
      .map(({ score: _score, ...item }) => item);
  }

  /** Validate untrusted webview paths immediately before they enter the prompt. */
  async validate(cwd: string, requested: readonly string[]): Promise<ValidatedProjectFiles> {
    const unique = [...new Set(requested.map(normalizeRelativePath).filter(Boolean))];
    if (unique.length > MAX_FILE_REFERENCES) {
      throw new Error(`At most ${MAX_FILE_REFERENCES} project files can be referenced at once.`);
    }

    const index = await this.load(cwd);
    const ignoredSet = new Set(index.ignored);
    const paths: string[] = [];
    for (const path of unique) {
      if (!isSafeRelativePath(cwd, path)) throw new Error(`File reference escapes the workspace: ${path}`);
      if (isKnownBinary(path)) throw new Error(`Binary files cannot be referenced with @: ${path}`);
      if (ignoredSet.has(path) && isExcludedPath(path)) {
        throw new Error(`Files under vendor/build directories cannot be referenced with @: ${path}`);
      }
      const stat = await lstat(resolve(cwd, path));
      if (!stat.isFile()) {
        throw new Error(`Only regular project files can be referenced: ${path}`);
      }
      paths.push(path);
    }

    return {
      paths,
      ignored: paths.filter((path) => ignoredSet.has(path)),
      sensitive: paths.filter(isSensitive),
    };
  }

  private async load(cwd: string): Promise<FileIndex> {
    const cached = this.cache.get(cwd);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return cached;

    let index: FileIndex;
    try {
      const [regular, ignored] = await Promise.all([
        gitFiles(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
        gitFiles(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]),
      ]);
      index = { createdAt: Date.now(), regular, ignored };
    } catch (error) {
      this.log(`git file discovery unavailable, using directory walk fallback: ${error instanceof Error ? error.message : String(error)}`);
      index = { createdAt: Date.now(), regular: await walkFiles(cwd), ignored: [] };
    }
    this.cache.set(cwd, index);
    return index;
  }
}

/** Non-git fallback: shallow recursive walk skipping the same excluded directories. */
async function walkFiles(cwd: string): Promise<string[]> {
  const results: string[] = [];
  const queue: string[] = [""];
  while (queue.length > 0 && results.length < MAX_INDEX_FILES) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(resolve(cwd, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name.toLowerCase())) queue.push(rel);
      } else if (entry.isFile()) {
        results.push(normalizeRelativePath(rel));
        if (results.length >= MAX_INDEX_FILES) break;
      }
    }
  }
  return results;
}

async function gitFiles(cwd: string, args: string[]): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  return String(stdout)
    .split("\0")
    .map(normalizeRelativePath)
    // Drop bulk vendor/build directories before truncating, so real project
    // files (e.g. a gitignored todo.md at the root) are never crowded out.
    .filter((path) => Boolean(path) && !isExcludedPath(path))
    .slice(0, MAX_INDEX_FILES);
}

function normalizeRelativePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function isSafeRelativePath(cwd: string, path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\0") || /[\r\n]/.test(path)) return false;
  const absolute = resolve(cwd, path);
  const rel = relative(cwd, absolute);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isKnownBinary(path: string): boolean {
  return BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

function isSensitive(path: string): boolean {
  const name = basename(path).toLowerCase();
  return SENSITIVE_NAMES.has(name)
    || name.startsWith(".env.")
    || name.endsWith(".pem")
    || name.endsWith(".key")
    || /(^|\/)(secrets?|credentials?)(\/|\.|$)/i.test(path);
}

function scorePath(path: string, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 1;
  const candidate = path.toLowerCase();
  const name = basename(candidate);
  if (name === needle) return 100;
  if (name.startsWith(needle)) return 80;
  if (name.includes(needle)) return 60;
  if (candidate.startsWith(needle)) return 50;
  if (candidate.includes(needle)) return 30;

  // Lightweight ordered-character fuzzy match for queries such as "sarm".
  let position = 0;
  for (const char of needle) {
    position = candidate.indexOf(char, position);
    if (position === -1) return -1;
    position += 1;
  }
  return 10;
}
