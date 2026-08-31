/**
 * Writing a single value into a shared JSONC config file.
 *
 * Both files this touches (`~/.pi/agent/models.json` and the two
 * `settings.json`) are hand-edited by users and read by the CLI, so a write has
 * to behave like a hand edit: comments and formatting survive, an editor that
 * already has the file open stays in sync, and the change lands through the
 * same save that a manual edit would (which is what triggers the reload
 * watchers). `jsonc-parser`'s `modify()` plus a whole-document `WorkspaceEdit`
 * is the only combination that does all three.
 *
 * Deliberately narrow: this is a helper for the writes that already exist (one
 * provider entry, one settings key), not a general config editor. Adding
 * field-level writes on top of it is explicitly out of scope — see AGENTS.md.
 */

import * as vscode from "vscode";
import { applyEdits, modify, type JSONPath } from "jsonc-parser";

/**
 * `unchanged` means the file already says what was asked (removing a key that
 * was never there, for one). The two callers disagree about whether that is a
 * failure, so it is reported rather than folded into a boolean.
 */
export type JsoncWriteResult = "written" | "unchanged" | "failed";

/** Indentation for structural edits, matching the SDK's own writes. */
const FORMATTING = { tabSize: 2, insertSpaces: true };

/** Set (or, with `undefined`, remove) one value in a JSONC file and save it. */
export async function writeJsoncValue(path: string, jsonPath: JSONPath, value: unknown): Promise<JsoncWriteResult> {
  const uri = vscode.Uri.file(path);
  const document = await vscode.workspace.openTextDocument(uri);
  const text = document.getText();
  const edits = modify(text, jsonPath, value, { formattingOptions: FORMATTING });
  if (edits.length === 0) return "unchanged";
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(text.length)), applyEdits(text, edits));
  if (!(await vscode.workspace.applyEdit(edit))) return "failed";
  return (await document.save()) ? "written" : "failed";
}
