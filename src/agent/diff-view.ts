import { applyPatch, parsePatch, reversePatch } from "diff";
import * as vscode from "vscode";
import { tf } from "./i18n.js";

/** URI scheme serving the pre-edit content of a file for `vscode.diff`. */
export const ORIGINAL_SCHEME = "pi-agent-chat-original";

/**
 * Serves reconstructed "before" content for diff views.
 *
 * The `edit` tool only reports a unified patch, and the file on disk already
 * holds the new content, so the original is recovered by reverse-applying the
 * patch. Content is registered per URI before the diff is opened.
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
 * Open a native side-by-side diff for one `edit` tool result.
 *
 * Falls back to showing the raw patch when the original content cannot be
 * reconstructed (file deleted, edited again afterwards, binary content, ...).
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

/** Recover the pre-edit content by applying the inverted patch to the new content. */
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
