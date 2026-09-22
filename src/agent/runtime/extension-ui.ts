import * as vscode from "vscode";
import type { ExtensionUIContext, WidgetPlacement } from "@earendil-works/pi-coding-agent";
import { t } from "../i18n.js";
import type { ExtensionNotice, ExtensionStatusUpdate, ExtensionWidgetUpdate } from "./types.js";

/**
 * 把 SDK 的扩展 UI 钩子映射到 VS Code 原生对话框。
 *
 * `notify` 接 sink 后进 transcript（多行报告会被弹窗截断），原生弹窗保留
 * 兜底、不静默丢消息。`setStatus` / `setWidget` / `setWorkingMessage` 并非
 * TUI-only：字符串形态描述内容而非布局，每个宿主都欠渲染；曾落进 Proxy 被
 * 静默吞掉，扩展在此无声失效而 CLI 正常。
 *
 * **为什么每个成员都必须显式列出**：SDK 的 `ExtensionRunner.setUIContext()`
 * 经 `wrapUIPromptContext()` 把这份上下文 `{ ...ui }` 展开成普通对象再交给
 * 扩展——spread 只拷贝目标对象的自有属性，下面 Proxy 的 `get` 兜底陷阱到
 * 不了扩展手里。凡是没在这里显式站出来的成员，扩展调用即
 * 「not a function」（issue #7：token-stats-timer 在 `agent_settled` 里调
 * `setWorkingMessage()` 直接炸）。SDK 升级给接口加成员时，这里必须跟着补。
 */
export function createVsCodeExtensionUiContext(sinks: {
  notice?: (notice: ExtensionNotice) => void;
  status?: (update: ExtensionStatusUpdate) => void;
  widget?: (update: ExtensionWidgetUpdate) => void;
  workingMessage?: (text: string | undefined) => void;
  workingVisible?: (visible: boolean) => void;
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
    /** 流式期间的「正在工作」文案；`undefined` = 恢复默认（不显示这一行）。 */
    setWorkingMessage(message?: unknown): void {
      sinks.workingMessage?.(message === undefined ? undefined : String(message));
    },
    /** 显隐扩展自定义的工作文案行；transcript 自己的运行指示不受它管。 */
    setWorkingVisible(visible: unknown): void {
      sinks.workingVisible?.(Boolean(visible));
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
    /* 以下成员本宿主没有对应表面，但必须显式 no-op：缺了它们，扩展拿到的
       展开副本上就是 undefined，一调用即崩（见文件头注释）。 */
    // 转圈动画的形状（frames）是 TUI 呈现层。
    setWorkingIndicator: () => {},
    // CLI 折叠思考块的占位文案；transcript 的思考行由宿主画。
    setHiddenThinkingLabel: () => {},
    // 组件工厂（同 `setWidget` 的 factory 重载），webview 渲染不了。
    setFooter: () => {},
    setHeader: () => {},
    setEditorComponent: () => {},
    // 终端窗口标题：webview 不拥有窗口。
    setTitle: () => {},
    // CLI 核心输入框的写入 / 粘贴 / 补全分层：composer 由宿主管着，扩展
    // 覆写用户正在敲的草稿需要专门设计，不在这里顺手做。
    setEditorText: () => {},
    pasteToEditor: () => {},
    addAutocompleteProvider: () => {},
    // 工具输出的展开态是 CLI 的渲染选项。
    setToolsExpanded: () => {},
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

  // Proxy 只是最后防线（同宿主代码直接摸这份上下文时兜底）；如文件头所述，
  // 它救不了扩展——扩展拿到的是展开副本，成员齐全靠上面的显式清单。
  return new Proxy(implemented, {
    get(target, property) {
      if (property in target) return target[property as string];
      // 不支持的 TUI 专属表面：吞掉调用而不是抛错。
      return () => undefined;
    },
    has: () => true,
  }) as unknown as ExtensionUIContext;
}
