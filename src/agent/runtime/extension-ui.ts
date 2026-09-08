import * as vscode from "vscode";
import type { ExtensionUIContext, WidgetPlacement } from "@earendil-works/pi-coding-agent";
import { t } from "../i18n.js";
import type { ExtensionNotice, ExtensionStatusUpdate, ExtensionWidgetUpdate } from "./types.js";

/**
 * 把 SDK 的扩展 UI 钩子映射到 VS Code 原生对话框。
 *
 * `ExtensionUIContext` 的 TUI 专属成员（组件、主题、原始终端输入）由 no-op
 * Proxy 兜底，避免为终端写的扩展在扩展宿主里崩溃。`notify` 接 sink 后进
 * transcript（多行报告会被弹窗截断），原生弹窗保留兜底、不静默丢消息。
 * `setStatus` / `setWidget` 并非 TUI-only：字符串形态描述内容而非布局，
 * 每个宿主都欠渲染；曾落进 Proxy 被静默吞掉，扩展在此无声失效而 CLI 正常。
 */
export function createVsCodeExtensionUiContext(sinks: {
  notice?: (notice: ExtensionNotice) => void;
  status?: (update: ExtensionStatusUpdate) => void;
  widget?: (update: ExtensionWidgetUpdate) => void;
}): ExtensionUIContext {
  const implemented: Record<string, unknown> = {
    async select(title: string, options: string[]): Promise<string | undefined> {
      return vscode.window.showQuickPick(options, { title, ignoreFocusOut: true });
    },
    async confirm(title: string, message: string): Promise<boolean> {
      const yes = t("confirmYes");
      const answer = await vscode.window.showInformationMessage(title, { modal: true, detail: message }, yes);
      return answer === yes;
    },
    async input(title: string, placeholder?: string): Promise<string | undefined> {
      return vscode.window.showInputBox({ title, placeHolder: placeholder, ignoreFocusOut: true });
    },
    async editor(title: string, prefill?: string): Promise<string | undefined> {
      return vscode.window.showInputBox({ title, value: prefill, ignoreFocusOut: true });
    },
    notify(message: string, type: "info" | "warning" | "error" = "info"): void {
      if (sinks.notice) {
        sinks.notice({ level: type, text: message });
        return;
      }
      if (type === "error") vscode.window.showErrorMessage(message);
      else if (type === "warning") vscode.window.showWarningMessage(message);
      else vscode.window.showInformationMessage(message);
    },
    setStatus(key: string, text: string | undefined): void {
      sinks.status?.({ key, text: text === undefined ? undefined : String(text) });
    },
    /**
     * 只转发 `string[]` 重载。另一个接收 `(tui, theme) => Component` 工厂，
     * webview 渲染不了；直接丢弃可让扩展继续运行（widget 缺失）而非调用失败。
     */
    setWidget(key: string, content: unknown, options?: { placement?: WidgetPlacement }): void {
      if (typeof content === "function") return;
      const lines = content === undefined ? undefined : Array.isArray(content) ? content.map(String) : [String(content)];
      sinks.widget?.({ key, lines, placement: options?.placement ?? "aboveEditor" });
    },
    onTerminalInput: () => () => {},
    getEditorText: () => "",
    getEditorComponent: () => undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching is not supported in the VS Code webview" }),
    getToolsExpanded: () => false,
    async custom() {
      return undefined;
    },
  };

  return new Proxy(implemented, {
    get(target, property) {
      if (property in target) return target[property as string];
      // 不支持的 TUI 专属表面：吞掉调用而不是抛错。
      return () => undefined;
    },
    has: () => true,
  }) as unknown as ExtensionUIContext;
}
