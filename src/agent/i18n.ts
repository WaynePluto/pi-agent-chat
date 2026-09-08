import * as vscode from "vscode";
import { isChinese, sharedMessages, sharedTemplates } from "../shared/messages.js";

/**
 * 宿主侧本地化：按 VS Code 界面语言在共享字典中取文案。
 * webview 无法 import `vscode`，有自己的入口（`webview/i18n.ts`）。
 */

type Templates = typeof sharedTemplates;

/** 固定文案，如 `t("resumeSessionTitle")`。 */
export function t(key: keyof typeof sharedMessages): string {
  const entry = sharedMessages[key];
  return isChinese(vscode.env.language) ? entry.zh : entry.en;
}

/** 参数化文案，如 `tf("signedIn", provider.name)`。 */
export function tf<K extends keyof Templates>(key: K, ...args: Parameters<Templates[K]["en"]>): string {
  const entry = sharedTemplates[key];
  const render = (isChinese(vscode.env.language) ? entry.zh : entry.en) as (...values: unknown[]) => string;
  return render(...args);
}
