/**
 * 向共享 JSONC 配置文件写入单个值。
 *
 * 涉及的文件既被用户手改、又被 CLI 读取，写入必须表现得像一次手改：
 * 注释与格式保留、已打开该文件的编辑器保持同步、落盘走与手改相同的
 * save 路径（reload watcher 由此触发）。`jsonc-parser` 的 `modify()` +
 * 整文档 `WorkspaceEdit` 是唯一三者兼备的组合。
 *
 * 故意收窄：只服务既有的两种写入，不做通用配置编辑器——见 AGENTS.md。
 */

import * as vscode from "vscode";
import { applyEdits, modify, type JSONPath } from "jsonc-parser";

/**
 * `unchanged` 表示文件本来就是要写的内容（如删除从未存在的键）。两个
 * 调用方对这算不算失败意见不一，故如实上报而不是折成布尔。
 */
export type JsoncWriteResult = "written" | "unchanged" | "failed";

/** 结构化编辑的缩进，与 SDK 自己的写入保持一致。 */
const FORMATTING = { tabSize: 2, insertSpaces: true };

/** 在 JSONC 文件中设置（传 `undefined` 则删除）一个值并保存。 */
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
