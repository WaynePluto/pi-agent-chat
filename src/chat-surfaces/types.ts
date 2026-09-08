import * as vscode from "vscode";
import type { SurfaceConnection } from "./surface-connection.js";

export const CHAT_VIEW_ID = "piAgentChat.view";
export const CHAT_PANEL_TYPE = "piAgentChat.editor";
export const MAX_EDITOR_TAB_TITLE_CHARS = 32;

/**
 * 两种 surface、用户心中的三个区域：侧边栏视图与编辑区 panel——后者可落在
 * 本窗口编辑区或浮动窗口。API 不区分后两者：`WebviewPanel` 不带窗口身份、
 * `window.tabGroups` 只读，panel 属于哪个区域只能由这里的 `PanelRegion`
 * 记账，API 回答不了。
 */
export type SurfaceKind = "sidebar" | "editor";
export type ControllerSlot = SurfaceKind | "background";

/** 编辑区 panel 当前所在区域；由 `viewColumn` 校正，见 connectEditorPanel。 */
export type PanelRegion = "editor" | "window";

export interface EditorPanelEntry {
  panel: vscode.WebviewPanel;
  surface: SurfaceConnection;
  region: PanelRegion;
}

export interface LastSession {
  cwd: string;
  file: string | null;
}
