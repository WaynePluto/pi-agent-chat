/**
 * Custom providers and models: the `~/.pi/agent/models.json` side of provider
 * setup.
 *
 * pi has no UI for this file — neither the CLI nor the SDK offers one — and the
 * schema is far too wide for a QuickPick wizard (four API types, a dozen compat
 * switches, cost tiers, thinking level maps, per-model overrides). A wizard
 * would cover a fraction of it, still send the user to the file for the rest,
 * and would be a GUI-only config editor with no CLI counterpart. So the GUI
 * does what the CLI expects — open the file — plus the two things a GUI can
 * genuinely add: seed a documented template into an empty file, and reload the
 * configuration when the file is saved (`ChatBridge`).
 *
 * The file is shared with the CLI; nothing here is plugin-private.
 */

import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { applyEdits, findNodeAtLocation, modify, parse, parseTree, type ParseError } from "jsonc-parser";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { modelsConfigProviderEntry, modelsConfigTemplate, modelsConfigTemplateProviderId, isChinese } from "../shared/messages.js";
import { t } from "./i18n.js";

/** `~/.pi/agent/models.json`, the same path `ModelRuntime` loads. */
export function modelsConfigPath(): string {
  return join(getAgentDir(), "models.json");
}

/** Indentation for the structural edits, matching the seeded template. */
const FORMATTING = { tabSize: 2, insertSpaces: true };

/** Whether a saved document is that file (case-insensitive on Windows). */
export function isModelsConfigPath(fsPath: string): boolean {
  const normalize = (path: string) => {
    const unified = path.replace(/[\\/]+/g, "/");
    return process.platform === "win32" ? unified.toLowerCase() : unified;
  };
  return normalize(fsPath) === normalize(modelsConfigPath());
}

/**
 * Open models.json for editing, always with a fresh provider template to work
 * from: the whole file when it is missing or empty, one more entry when it
 * already defines providers.
 *
 * The document is switched to `jsonc` because pi strips comments before
 * parsing, while VS Code's strict `json` mode would flag every comment line.
 */
export async function openModelsConfig(): Promise<void> {
  const path = modelsConfigPath();
  let content = "";
  try {
    content = await fs.readFile(path, "utf8");
  } catch {
    // Missing file: seeded below.
  }
  const seeded = !content.trim();
  if (seeded) {
    try {
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, localized(modelsConfigTemplate), "utf8");
    } catch {
      // Seeding is a convenience; fall through and open whatever is there.
    }
  }
  let document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  if (document.languageId !== "jsonc") {
    // Returns the re-typed document; the previous handle must not be reused.
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
 * Add one more commented provider template at the top of `"providers"`.
 *
 * Text insertion rather than `modify()` with a value: the value form would
 * serialize plain JSON and drop every field comment, which is the point of the
 * template. The edit is deliberately left unsaved — it is undoable that way,
 * and an untouched placeholder provider should not reach the model picker.
 *
 * Returns the range of the inserted entry, or undefined when the file cannot be
 * parsed (the error card already explains that) or has no object at its root.
 */
async function insertProviderTemplate(document: vscode.TextDocument): Promise<vscode.Range | undefined> {
  let text = document.getText();
  const errors: ParseError[] = [];
  const parsed = parse(text, errors) as { providers?: unknown } | undefined;
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const providers = parsed.providers;
  const usable = Boolean(providers) && typeof providers === "object" && !Array.isArray(providers);
  const existing = usable ? Object.keys(providers as object) : [];
  // No usable "providers" object yet: create an empty one so the
  // comment-carrying text below has somewhere to go.
  if (!usable) text = applyEdits(text, modify(text, ["providers"], {}, { formattingOptions: FORMATTING }));

  const tree = parseTree(text);
  const providersNode = tree ? findNodeAtLocation(tree, ["providers"]) : undefined;
  if (!providersNode) return undefined;
  // Insert right after the opening brace: prepending needs no knowledge of the
  // last entry's trailing comment or comma, and puts the new block in view.
  const insertAt = providersNode.offset + 1;
  const entry = localized(modelsConfigProviderEntry).replace(
    `"${modelsConfigTemplateProviderId}"`,
    `"${uniqueProviderId(existing)}"`,
  );
  const snippet = `\n${entry}${existing.length > 0 ? "," : ""}`;
  const updated = `${text.slice(0, insertAt)}${snippet}${text.slice(insertAt)}`;

  const edit = new vscode.WorkspaceEdit();
  const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  edit.replace(document.uri, whole, updated);
  if (!(await vscode.workspace.applyEdit(edit))) return undefined;
  return new vscode.Range(document.positionAt(insertAt + 1), document.positionAt(insertAt + snippet.length));
}

/** `my-provider`, `my-provider-2`, ... - never reuse an id the file already has. */
function uniqueProviderId(existing: readonly string[]): string {
  if (!existing.includes(modelsConfigTemplateProviderId)) return modelsConfigTemplateProviderId;
  for (let index = 2; ; index++) {
    const candidate = `${modelsConfigTemplateProviderId}-${index}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

/** The "nothing configured" file pi accepts: an empty `providers` map. */
const EMPTY_MODELS_CONFIG = `{\n  "providers": {}\n}\n`;

/**
 * Restore models.json to `{ "providers": {} }` when it holds no configuration.
 *
 * The two states pi rejects here are dead ends that mean the same thing: an
 * empty file fails to parse, and `{}` fails the schema because `providers` is
 * required. Both express "no custom configuration", which an empty `providers`
 * map says in a form pi accepts - so writing it repairs the file without
 * touching anything the user wrote. A file with any other content is left
 * alone: its error is about content only the user can fix.
 */
export async function repairEmptyModelsConfig(): Promise<boolean> {
  const path = modelsConfigPath();
  try {
    if (!holdsNoConfiguration(await fs.readFile(path, "utf8"))) return false;
  } catch {
    return false; // Missing file: nothing to repair, pi is fine without it.
  }
  const uri = vscode.Uri.file(path);
  const document = await vscode.workspace.openTextDocument(uri);
  // The user may have started typing again between their save and this reload;
  // never overwrite a buffer that is ahead of the disk.
  if (document.isDirty) return false;
  const edit = new vscode.WorkspaceEdit();
  const whole = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  edit.replace(uri, whole, EMPTY_MODELS_CONFIG);
  if (!(await vscode.workspace.applyEdit(edit))) return false;
  return await document.save();
}

/** Nothing at all, or an object without a single property (`{}`). */
function holdsNoConfiguration(text: string): boolean {
  if (!text.trim()) return true;
  const errors: ParseError[] = [];
  const parsed = parse(text, errors) as unknown;
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  return Object.keys(parsed).length === 0;
}

/**
 * Provider ids defined in models.json, i.e. the ones a user can remove from
 * there. Includes overrides of built-in providers: deleting such an entry drops
 * the override, not the provider.
 *
 * Parsing is tolerant (`jsonc-parser`); a file too broken to read just yields
 * no removable providers, and `ModelRuntime.getError()` already reports why.
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
 * Remove one provider from models.json.
 *
 * The edit goes through `jsonc-parser` + a `WorkspaceEdit` rather than a
 * rewrite: comments, formatting and the rest of the file survive, and an editor
 * that already has the file open (possibly with unsaved changes) stays in sync.
 * Saving it is what applies the change — the same path a hand edit takes, so
 * `ChatBridge`'s save watcher reloads the configuration.
 */
export async function deleteConfiguredProvider(providerId: string): Promise<boolean> {
  const uri = vscode.Uri.file(modelsConfigPath());
  const document = await vscode.workspace.openTextDocument(uri);
  const text = document.getText();
  const edits = modify(text, ["providers", providerId], undefined, { formattingOptions: FORMATTING });
  if (edits.length === 0) return false;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(text.length)), applyEdits(text, edits));
  if (!(await vscode.workspace.applyEdit(edit))) return false;
  return await document.save();
}
