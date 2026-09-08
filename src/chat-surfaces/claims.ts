import * as vscode from "vscode";

/** 会话文件的窗口级归属登记。 */
export class SessionClaimRegistry<T extends object> {
  private readonly owners = new Map<string, T>();

  owner(file: string): T | undefined {
    return this.owners.get(sessionKey(file));
  }

  claim(file: string, owner: T): boolean {
    const key = sessionKey(file);
    const current = this.owners.get(key);
    if (current && current !== owner) return false;
    this.owners.set(key, owner);
    return true;
  }

  release(file: string, owner: T): void {
    const key = sessionKey(file);
    if (this.owners.get(key) === owner) this.owners.delete(key);
  }
}

/**
 * 由宿主自检钉住的纯所有权规则：controller 正在写入的会话文件，即它在本窗口
 * 独占 claim 的文件。
 *
 * 不看 controller 的 webview 显示什么：屏幕上的子代理 transcript 或回放会话
 * 属于别的 writer；claim 它既会把自己正在写的文件拱手让人，又会把运行中的
 * 任务线变成每个会话列表里的普通行。
 */
export function ownedSessionFiles(options: {
  sessionFile?: string;
  runningLaneFiles?: readonly string[];
}): string[] {
  const owned = new Set<string>();
  if (options.sessionFile) owned.add(options.sessionFile);
  for (const file of options.runningLaneFiles ?? []) owned.add(file);
  return [...owned];
}

function sessionKey(file: string): string {
  const normalized = vscode.Uri.file(file).fsPath;
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
