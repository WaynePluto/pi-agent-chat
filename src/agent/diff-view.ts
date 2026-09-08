import { applyPatch, parsePatch, reversePatch } from "diff";
import * as vscode from "vscode";
import { tf } from "./i18n.js";

/** 为 `vscode.diff` 提供文件改前内容的 URI scheme。 */
export const ORIGINAL_SCHEME = "pi-agent-chat-original";

/**
 * 为 diff 视图提供重建的「改前」内容。
 *
 * `edit` 工具只回报 unified patch，磁盘上的文件已是新内容，因此原内容
 * 靠反向应用 patch 重建；内容按 URI 注册，开 diff 之前写入。
 */
export class OriginalContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.emitter.fire(uri);
  }

  dispose(): void {
    this.contents.clear();
    this.emitter.dispose();
  }
}

/**
 * 为一次 `edit` 工具结果打开原生并排 diff。
 *
 * 原内容无法重建时（文件被删、事后又改过、二进制内容等）回退为
 * 直接展示原始 patch 文本。
 */
export async function openEditDiff(
  provider: OriginalContentProvider,
  filePath: string,
  patch: string,
): Promise<void> {
  const fileUri = filePath ? vscode.Uri.file(filePath) : undefined;
  const current = fileUri ? await readFileText(fileUri) : undefined;

  if (fileUri && current !== undefined) {
    const original = reverseApply(current, patch);
    if (original !== undefined) {
      const originalUri = fileUri.with({ scheme: ORIGINAL_SCHEME, query: `t=${Date.now()}` });
      provider.set(originalUri, original);
      const name = filePath.split(/[\\/]/).pop() ?? filePath;
      await vscode.commands.executeCommand("vscode.diff", originalUri, fileUri, tf("diffEditorTitle", name), {
        preview: true,
      });
      return;
    }
  }

  const doc = await vscode.workspace.openTextDocument({ content: patch, language: "diff" });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function readFileText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

/** 对新内容应用反转后的 patch，恢复改前内容。 */
function reverseApply(newContent: string, patch: string): string | undefined {
  try {
    const parsed = parsePatch(patch);
    if (parsed.length === 0) return undefined;
    let result = newContent;
    for (const single of reversePatch(parsed)) {
      const applied = applyPatch(result, single);
      if (applied === false) return undefined;
      result = applied;
    }
    return result;
  } catch {
    return undefined;
  }
}
