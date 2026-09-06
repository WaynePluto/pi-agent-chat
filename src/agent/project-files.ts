import { execFile } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { MAX_FILE_REFERENCES, type ProjectFileItem } from "../shared/protocol.js";
import { describe } from "./errors.js";

const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 5_000;
const MAX_INDEX_ITEMS = 20_000;

const BINARY_EXTENSIONS = new Set([
  ".7z", ".a", ".avi", ".bin", ".bmp", ".class", ".dll", ".dylib", ".exe", ".flac", ".gif", ".gz",
  ".ico", ".jar", ".jpeg", ".jpg", ".lib", ".mov", ".mp3", ".mp4", ".o", ".obj", ".pdf", ".png",
  ".so", ".tar", ".tiff", ".ttf", ".wav", ".webm", ".webp", ".woff", ".woff2", ".xz", ".zip",
]);

const SENSITIVE_NAMES = new Set([
  ".env", ".env.local", ".npmrc", ".pypirc", "auth.json", "credentials.json", "id_dsa", "id_ed25519", "id_rsa",
]);

/** Bulk vendor/build directories that are never searchable or referenceable. */
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
  regular: ProjectFileItem[];
  ignored: ProjectFileItem[];
}

export interface ValidatedProjectFiles {
  paths: string[];
  directories: string[];
  ignored: string[];
  sensitive: string[];
}

/** Project file and directory discovery for the webview's @ picker. */
export class ProjectFileIndex {
  private readonly cache = new Map<string, FileIndex>();

  constructor(private readonly log: (message: string) => void) {}

  async search(cwd: string, query: string, includeIgnored: boolean, maxResults = 100): Promise<ProjectFileItem[]> {
    const index = await this.load(cwd);
    const regularPaths = new Set(index.regular.map((item) => item.path));
    // Bulk directories (node_modules etc.) are never searchable, regardless of
    // the "show ignored" toggle; git-tracked paths are already filtered too.
    const selected = includeIgnored
      ? [...index.regular, ...index.ignored.filter((item) => !regularPaths.has(item.path))]
      : index.regular;
    return selected
      .filter((item, position, all) => all.findIndex((candidate) => candidate.path === item.path) === position)
      .filter((item) => item.kind === "directory" || !isKnownBinary(item.path))
      .map((item) => ({ ...item, score: scorePath(item.path, query) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, maxResults)
      .map(({ score: _score, ...item }) => item);
  }

  /** Validate untrusted webview paths immediately before they enter the prompt. */
  async validate(cwd: string, requested: readonly string[]): Promise<ValidatedProjectFiles> {
    const unique = [...new Set(requested.map(normalizeRelativePath).filter(Boolean))];
    if (unique.length > MAX_FILE_REFERENCES) {
      throw new Error(`At most ${MAX_FILE_REFERENCES} project paths can be referenced at once.`);
    }

    const index = await this.load(cwd);
    const ignoredSet = new Set(index.ignored.map((item) => item.path));
    const paths: string[] = [];
    const directories: string[] = [];
    for (const path of unique) {
      if (!isSafeRelativePath(cwd, path)) throw new Error(`Project reference escapes the workspace: ${path}`);
      if (isExcludedPath(path)) {
        throw new Error(`Paths under vendor/build directories cannot be referenced with @: ${path}`);
      }
      const stat = await lstat(resolve(cwd, path));
      if (!stat.isFile() && !stat.isDirectory()) {
        throw new Error(`Only regular project files and directories can be referenced: ${path}`);
      }
      if (stat.isFile() && isKnownBinary(path)) throw new Error(`Binary files cannot be referenced with @: ${path}`);
      paths.push(path);
      if (stat.isDirectory()) directories.push(path);
    }

    return {
      paths,
      directories,
      ignored: paths.filter((path) => ignoredSet.has(path)),
      sensitive: paths.filter(isSensitive),
    };
  }

  private async load(cwd: string): Promise<FileIndex> {
    const cached = this.cache.get(cwd);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) return cached;

    let index: FileIndex;
    try {
      const [regularFiles, ignoredFiles, deleted] = await Promise.all([
        gitFiles(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
        gitFiles(cwd, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]),
        // An index entry can remain after its working-tree file was deleted or
        // moved but before the user stages the change. Do not expose that stale
        // path in the @ picker.
        gitFiles(cwd, ["ls-files", "--deleted", "-z"]),
      ]);
      const deletedSet = new Set(deleted);
      index = buildIndex(
        regularFiles.filter((path) => !deletedSet.has(path)),
        ignoredFiles.filter((path) => !deletedSet.has(path)),
      );
    } catch (error) {
      this.log(`git file discovery unavailable, using directory walk fallback: ${describe(error)}`);
      index = { createdAt: Date.now(), regular: await walkProjectPaths(cwd), ignored: [] };
    }
    this.cache.set(cwd, index);
    return index;
  }
}

function buildIndex(regularFiles: string[], ignoredFiles: string[]): FileIndex {
  const regular = indexFilesAndParents(regularFiles);
  const regularPaths = new Set(regular.map((item) => item.path));
  const ignored = indexFilesAndParents(ignoredFiles)
    .filter((item) => !regularPaths.has(item.path))
    .map((item) => ({ ...item, ignored: true }));
  return { createdAt: Date.now(), regular, ignored };
}

function indexFilesAndParents(files: string[]): ProjectFileItem[] {
  const items = new Map<string, ProjectFileItem>();
  for (const path of files) {
    items.set(path, { path, kind: "file", sensitive: isSensitive(path) || undefined });
    addParentDirectories(items, path);
  }
  return [...items.values()];
}

function addParentDirectories(items: Map<string, ProjectFileItem>, path: string): void {
  const segments = path.split("/");
  segments.pop();
  while (segments.length > 0) {
    const directory = segments.join("/");
    if (!items.has(directory)) {
      items.set(directory, { path: directory, kind: "directory", sensitive: isSensitive(directory) || undefined });
    }
    segments.pop();
  }
}

/** Non-git fallback: shallow recursive walk skipping the same excluded directories. */
async function walkProjectPaths(cwd: string): Promise<ProjectFileItem[]> {
  const results: ProjectFileItem[] = [];
  const queue: string[] = [""];
  while (queue.length > 0 && results.length < MAX_INDEX_ITEMS) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(resolve(cwd, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = normalizeRelativePath(dir ? `${dir}/${entry.name}` : entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name.toLowerCase())) {
          results.push({ path: rel, kind: "directory", sensitive: isSensitive(rel) || undefined });
          queue.push(rel);
        }
      } else if (entry.isFile()) {
        results.push({ path: rel, kind: "file", sensitive: isSensitive(rel) || undefined });
      }
      if (results.length >= MAX_INDEX_ITEMS) break;
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
    // paths (e.g. a gitignored todo.md at the root) are never crowded out.
    .filter((path) => Boolean(path) && !isExcludedPath(path))
    .slice(0, MAX_INDEX_ITEMS);
}

function normalizeRelativePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
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
  const needle = query.trim().replace(/\/+$/, "").toLowerCase();
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
