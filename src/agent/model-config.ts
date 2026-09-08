/**
 * 自定义供应商与模型：供应商接入中 `~/.pi/agent/models.json` 那一侧。
 * pi 对这个文件没有 UI（CLI 与 SDK 都不给），schema 也远超 QuickPick
 * 向导能覆盖的面。所以 GUI 做 CLI 期望的事——打开文件——再加两件
 * GUI 真能添的：尚未配置时种下一份带注释的模板，保存时经
 * `ChatBridge` 重载配置。该文件与 CLI 共享，这里没有插件私有之物。
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { applyEdits, findNodeAtLocation, modify, parse, parseTree, type ParseError } from "jsonc-parser";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { modelsConfigProviderEntry, modelsConfigTemplate, isChinese } from "../shared/messages.js";
import { writeJsoncValue } from "./jsonc-file.js";
import { t } from "./i18n.js";

/** `~/.pi/agent/models.json`，与 `ModelRuntime` 加载的同一份。 */
export function modelsConfigPath(): string {
  return join(getAgentDir(), "models.json");
}

/** 结构化编辑的缩进，与种下的模板一致。 */
const FORMATTING = { tabSize: 2, insertSpaces: true };

/** 某个已保存文档是否就是该文件（Windows 下不区分大小写）。 */
export function isModelsConfigPath(fsPath: string): boolean {
  const normalize = (path: string) => {
    const unified = path.replace(/[\\/]+/g, "/");
    return process.platform === "win32" ? unified.toLowerCase() : unified;
  };
  return normalize(fsPath) === normalize(modelsConfigPath());
}

/**
 * 打开 models.json 供编辑；尚未配置任何东西时先给一份可下手的 provider
 * 模板：文件缺失或为空时是整份模板，文件存在但没有 provider 时是一条
 * 条目。已配置 provider 的文件原样打开。
 *
 * 文档切到 `jsonc`：pi 解析前会剥注释，VS Code 严格的 `json` 模式却会
 * 把每一行注释标红。
 */
export async function openModelsConfig(): Promise<void> {
  const path = modelsConfigPath();
  let content = "";
  try {
    content = await fs.readFile(path, "utf8");
  } catch {
    // 文件缺失：下面会种模板。
  }
  const seeded = !content.trim();
  if (seeded) {
    try {
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, localized(modelsConfigTemplate), "utf8");
    } catch {
      // 种模板只是顺手；失败就照原样打开现有内容。
    }
  }
  let document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  if (document.languageId !== "jsonc") {
    // 返回的是改了语言的新文档句柄，旧句柄不可再用。
    document = await vscode.languages.setTextDocumentLanguage(document, "jsonc").then(
      (retyped) => retyped,
      () => document,
    );
  }
  const inserted = seeded ? undefined : await insertProviderTemplate(document);
  await vscode.window.showTextDocument(document, inserted ? { selection: inserted } : undefined);
  vscode.window.showInformationMessage(t(inserted ? "customProviderAppended" : "customProviderOpened"));
}

function localized(text: { en: string; zh: string }): string {
  return isChinese(vscode.env.language) ? text.zh : text.en;
}

/**
 * 在 `"providers"` 顶部加一条带注释的 provider 模板——仅当文件还没
 * 定义任何 provider；已配置的原样打开，模板是为从零开始的用户存在的。
 *
 * 用文本插入而非带值的 `modify()`：值形式序列化成纯 JSON，丢掉全部
 * 字段注释。编辑刻意不保存——可 Ctrl+Z 撤销，未动的占位 provider
 * 也不进模型选择器。返回插入条目的 range；已定义 provider、解析失败
 * （错误卡片已解释）或根不是对象时返回 undefined。
 */
async function insertProviderTemplate(document: vscode.TextDocument): Promise<vscode.Range | undefined> {
  let text = document.getText();
  const errors: ParseError[] = [];
  const parsed = parse(text, errors) as { providers?: unknown } | undefined;
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const providers = parsed.providers;
  const usable = Boolean(providers) && typeof providers === "object" && !Array.isArray(providers);
  const existing = usable ? Object.keys(providers as object) : [];
  // 文件已定义 provider：原样打开，模板没有可添的。
  if (existing.length > 0) return undefined;
  // 还没有可用的 "providers" 对象：先建一个空的，下面的带注释文本
  // 才有地方放。
  if (!usable) text = applyEdits(text, modify(text, ["providers"], {}, { formattingOptions: FORMATTING }));

  const tree = parseTree(text);
  const providersNode = tree ? findNodeAtLocation(tree, ["providers"]) : undefined;
  if (!providersNode) return undefined;
  // 紧跟左花括号插入：前插不需要了解最后一条的尾注释或逗号，
  // 也让新块落在可视区内。
  const insertAt = providersNode.offset + 1;
  // 这里 `existing` 必为空，模板 id `"my-provider"` 不会撞名，
  // 条目文本逐字使用。
  const snippet = `\n${localized(modelsConfigProviderEntry)}`;
  const updated = `${text.slice(0, insertAt)}${snippet}${text.slice(insertAt)}`;

  const edit = new vscode.WorkspaceEdit();
  const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  edit.replace(document.uri, whole, updated);
  if (!(await vscode.workspace.applyEdit(edit))) return undefined;
  return new vscode.Range(document.positionAt(insertAt + 1), document.positionAt(insertAt + snippet.length));
}

/** pi 能接受的「未配置」文件：空的 `providers` 映射。 */
const EMPTY_MODELS_CONFIG = `{\n  "providers": {}\n}\n`;

/**
 * models.json 不含任何配置时把它恢复成 `{ "providers": {} }`。
 *
 * pi 在这里拒绝的两种状态是含义相同的死胡同：空文件解析失败，`{}`
 * 因缺 `providers` 过不了 schema。两者都表达「没有自定义配置」，空
 * `providers` 映射用 pi 接受的形式说同一件事——写它是在修复文件，
 * 不碰用户写的任何东西。其余内容的文件不动：它的错误只有用户能修。
 */
export async function repairEmptyModelsConfig(): Promise<boolean> {
  const path = modelsConfigPath();
  try {
    if (!holdsNoConfiguration(await fs.readFile(path, "utf8"))) return false;
  } catch {
    return false; // 文件缺失：没有要修的，pi 没它也行。
  }
  const uri = vscode.Uri.file(path);
  const document = await vscode.workspace.openTextDocument(uri);
  // 用户可能在自己保存与这次重载之间又开始打字；
  // 缓冲区领先于磁盘时绝不覆盖。
  if (document.isDirty) return false;
  const edit = new vscode.WorkspaceEdit();
  const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  edit.replace(uri, whole, EMPTY_MODELS_CONFIG);
  if (!(await vscode.workspace.applyEdit(edit))) return false;
  return await document.save();
}

/** 什么都没有，或一个没有任何属性的对象（`{}`）。 */
function holdsNoConfiguration(text: string): boolean {
  if (!text.trim()) return true;
  const errors: ParseError[] = [];
  const parsed = parse(text, errors) as unknown;
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  return Object.keys(parsed).length === 0;
}

/**
 * models.json 里定义的 provider id，即用户能从那里删除的那些。包含对
 * 内置供应商的覆盖：删那样的条目丢的是覆盖，不是供应商本身。
 *
 * 解析是宽容的（`jsonc-parser`）；烂到读不出的文件只是不产出可删
 * provider，`ModelRuntime.getError()` 会说明原因。
 */
export async function configuredProviderIds(): Promise<Set<string>> {
  try {
    const text = await fs.readFile(modelsConfigPath(), "utf8");
    const parsed = parse(text) as { providers?: unknown } | undefined;
    const providers = parsed?.providers;
    return new Set(providers && typeof providers === "object" ? Object.keys(providers) : []);
  } catch {
    return new Set();
  }
}

/**
 * 从 models.json 删除一个 provider。
 *
 * 编辑走 `jsonc-parser` + `WorkspaceEdit` 而非重写：注释、格式与文件其余
 * 部分都保留，已打开该文件的编辑器（可能带着未保存修改）保持同步。
 * 保存即生效——与手改同一条路径，`ChatBridge` 的保存监听因此重载配置。
 */
export async function deleteConfiguredProvider(providerId: string): Promise<boolean> {
  return (await writeJsoncValue(modelsConfigPath(), ["providers", providerId], undefined)) === "written";
}
