import * as vscode from "vscode";
import { isChinese, sharedMessages, sharedTemplates } from "../shared/messages.js";

/**
 * Host-side localization: resolves the shared dictionary against the VS Code
 * display language. The webview has its own entry point (`webview/i18n.ts`)
 * because it cannot import `vscode`.
 */

type Templates = typeof sharedTemplates;

/** Fixed string, e.g. `t("resumeSessionTitle")`. */
export function t(key: keyof typeof sharedMessages): string {
  const entry = sharedMessages[key];
  return isChinese(vscode.env.language) ? entry.zh : entry.en;
}

/** Interpolated string, e.g. `tf("signedIn", provider.name)`. */
export function tf<K extends keyof Templates>(key: K, ...args: Parameters<Templates[K]["en"]>): string {
  const entry = sharedTemplates[key];
  const render = (isChinese(vscode.env.language) ? entry.zh : entry.en) as (...values: unknown[]) => string;
  return render(...args);
}
