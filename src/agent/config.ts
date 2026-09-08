import * as vscode from "vscode";
import { CONTENT_WIDTH_MIN, DEFAULT_CONTENT_MAX_WIDTH, DEFAULT_FOLD_LINES, DEFAULT_WIDE_THRESHOLD, WIDE_THRESHOLD_MIN } from "../shared/protocol.js";

/**
 * 插件自己的 VS Code 设置。只有仅存在于本宿主的能力才归这里；CLI 也
 * 有的能力留在共享的 `~/.pi/agent/` 配置（见 AGENTS.md「配置项归属」）。
 *
 * 子代理与终端设置按资源（工作区文件夹）读取：仓库能否容忍并行写入的
 * agent、能否容忍可见 shell 里跑命令，是仓库的属性；transcript 折叠
 * 阈值是纯用户偏好，按窗口作用域。
 */
const SECTION = "piAgentChat.subagent";

/**
 * 配置宽度的上限，这里与 `package.json` 双重强制。
 *
 * 清单里的 `maximum` 只约束设置界面，手改 `settings.json` 可填任意数。
 * 上限保护的是功能定义而非机器：宽到一定程度就没人跟得动 N 份
 * transcript，「可观察的并行」就不再是可观察的。
 */
export const SUBAGENT_HARD_CAP = 8;

export interface SubagentConfig {
  /** 是否提供该工具。用户未显式开启则关闭。 */
  readonly enabled: boolean;
  /** 单次调用上限；同时作为 schema 上限发布给模型。 */
  readonly maxSubagents: number;
  /** `provider/modelId`；留空继承父会话模型。 */
  readonly defaultModel?: string;
}

/**
 * 读取某个工作目录的当前配置。
 *
 * 在会话的工具集构造时调用，而不是启动时读一次：工具集在构造时固定，
 * 改设置只能经会话 reload 生效。
 */
export function readSubagentConfig(cwd: string): SubagentConfig {
  const scope = vscode.Uri.file(cwd);
  const config = vscode.workspace.getConfiguration(SECTION, scope);
  const rawMax = config.get<number>("maxSubagents") ?? 3;
  const rawModel = config.get<string>("defaultModel")?.trim();
  return {
    enabled: config.get<boolean>("enabled") ?? false,
    maxSubagents: clampSubagentLimit(rawMax),
    defaultModel: rawModel || undefined,
  };
}

/** 把配置值取整并夹到可用的子会话数。 */
export function clampSubagentLimit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(SUBAGENT_HARD_CAP, Math.max(1, Math.round(value)));
}

/** 某次设置变更是否触及本模块读取的任何项。 */
export function affectsSubagentConfig(event: vscode.ConfigurationChangeEvent, cwd: string): boolean {
  return event.affectsConfiguration(SECTION, vscode.Uri.file(cwd));
}

/* -- 深链（Deep link）---------------------------------------------------- */

/**
 * 本插件全部设置的顶层 section 前缀，用于把设置界面定位到完整插件
 * 作用域（子代理、终端工具、transcript 折叠……）。
 *
 * 这是侧边栏提供的*唯一*深链：设置在插件内没有自己的表单，它们就是
 * 普通 VS Code 设置，设置界面本就给了描述、用户/工作区页签与「在别处
 * 也已设置」标记。按功能的入口也已删——一个覆盖整个插件作用域的搜索框，
 * 好过若干各自只落到更窄过滤的菜单行。
 */
export function pluginSettingId(): string {
  return "piAgentChat";
}

/* -- 集成终端 ------------------------------------------------------------ */

const TERMINAL_SECTION = "piAgentChat.terminal";

/**
 * 工具可同时保持打开的终端数上限，这里与 `package.json` 双重强制
 * （清单的 `maximum` 只约束设置界面）。
 *
 * 终端是可见的共享表面：过了几台，终端面板就不是用户跟得动的东西了，
 * 而「一个你能看、能敲的终端」——这个工具在已有 `bash` 的宿主里存在的
 * 全部理由——也就不成立了。
 */
export const TERMINAL_HARD_CAP = 8;

export interface TerminalConfig {
  /** 是否提供该工具。用户未显式开启则关闭。 */
  readonly enabled: boolean;
  /** 可同时打开的终端数。 */
  readonly maxTerminals: number;
}

/**
 * 读取某个工作目录的当前终端工具配置。时机规则同
 * {@link readSubagentConfig}：在会话工具集构造时调用，那是变更的设置
 * 唯一能落地的地方。
 *
 * `enabled` 与数量刻意分成布尔，而不是把「关闭」折进 `maxTerminals: 0`：
 * 前者管能力存不存在（模型根本看不到该工具），后者管已存在的能力怎么
 * 行为。合并会让用户关再开都丢掉调好的值、与 `minimum: 1` 矛盾，还给
 * `0` 一个与多数工具「无限制」相反的含义。
 */
export function readTerminalConfig(cwd: string): TerminalConfig {
  const config = vscode.workspace.getConfiguration(TERMINAL_SECTION, vscode.Uri.file(cwd));
  return {
    enabled: config.get<boolean>("enabled") ?? false,
    maxTerminals: clampTerminalLimit(config.get<number>("maxTerminals") ?? 3),
  };
}

/** 把配置值取整并夹到可用的终端数。 */
export function clampTerminalLimit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(TERMINAL_HARD_CAP, Math.max(1, Math.round(value)));
}

/** 某次设置变更是否触及终端工具的设置。 */
export function affectsTerminalConfig(event: vscode.ConfigurationChangeEvent, cwd: string): boolean {
  return event.affectsConfiguration(TERMINAL_SECTION, vscode.Uri.file(cwd));
}

/* -- 宽屏布局 ------------------------------------------------------------ */

const LAYOUT_SECTION = "piAgentChat.layout";

/**
 * 居中消息区（transcript 与 composer）的最大宽度，像素。
 *
 * 清单的 `minimum` 只约束设置界面，这里为手改 `settings.json` 的值再夹
 * 一次。没有上限：这个设置只表达字面意思，5K 屏想要很宽的正文不是需要
 * 被纠正的错误。宽屏何时开始是另一个设置（{@link readWideThreshold}），
 * 正是为了调宽正文不会顺手把侧栏推远。
 */
export function readContentMaxWidth(): number {
  const raw = vscode.workspace.getConfiguration(LAYOUT_SECTION).get<number>("contentMaxWidth");
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_CONTENT_MAX_WIDTH;
  return Math.max(CONTENT_WIDTH_MIN, Math.round(raw));
}

/**
 * 三栏布局开始可用的 webview 宽度。
 *
 * 夹到 {@link WIDE_THRESHOLD_MIN} 而不是照单全收：低于它三栏无法同时
 * 满足各自最小宽度，手改的值会把布局切进一个它满足不了的形状。跨过
 * 阈值本身不打开任何栏，所以调低它是免费的。
 */
export function readWideThreshold(): number {
  const raw = vscode.workspace.getConfiguration(LAYOUT_SECTION).get<number>("wideModeMinWidth");
  if (raw === undefined || !Number.isFinite(raw)) return Math.max(WIDE_THRESHOLD_MIN, DEFAULT_WIDE_THRESHOLD);
  return Math.max(WIDE_THRESHOLD_MIN, Math.round(raw));
}

/** 某次设置变更是否触及任一宽屏几何值。 */
export function affectsLayoutConfig(event: vscode.ConfigurationChangeEvent): boolean {
  return (
    event.affectsConfiguration(`${LAYOUT_SECTION}.contentMaxWidth`) ||
    event.affectsConfiguration(`${LAYOUT_SECTION}.wideModeMinWidth`)
  );
}

/* -- 消息折叠 ------------------------------------------------------------ */

const TRANSCRIPT_SECTION = "piAgentChat.transcript";

/**
 * 消息气泡可折成预览的行数阈值。本宿主的纯呈现偏好，故放在这里而非
 * 共享的 `~/.pi/agent/` 配置。`0` 表示永不折叠；不是可用数字的值回落
 * 到文档默认值，而不是静默关掉该功能。
 */
export function readFoldLines(): number {
  const raw = vscode.workspace.getConfiguration(TRANSCRIPT_SECTION).get<number>("foldLines");
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_FOLD_LINES;
  return Math.max(0, Math.round(raw));
}

/** 某次设置变更是否触及折叠阈值。 */
export function affectsFoldConfig(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(`${TRANSCRIPT_SECTION}.foldLines`);
}

/**
 * 思考过程流式输出时是否保持展开、结束后折叠。本宿主的纯呈现偏好
 * （折叠阈值在这里的同一理由），因此按窗口而非按工作区作用域。不严格
 * 等于 `true` 一律读作关闭：手改 `settings.json` 填了错误类型时，
 * 默认关闭的行为必须存活。
 */
export function readShowThinking(): boolean {
  return vscode.workspace.getConfiguration(TRANSCRIPT_SECTION).get<boolean>("showThinking") === true;
}

/** 某次设置变更是否触及 showThinking 设置。 */
export function affectsShowThinkingConfig(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(`${TRANSCRIPT_SECTION}.showThinking`);
}

