/**
 * 协议里的数据形状与跨端共用常量：状态快照、列表行、资源清单、附件与
 * 命令目录。两向消息联合在 `./messages.ts`，布局几何在 `./layout.ts`。
 * 同母亲模块零依赖。
 */

export type ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 可安全结构化克隆的 JSON，用于宿主原样转发、不理解其形状的数据（目前是
 * 工具 `details`）。
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * 单条 prompt 可附加的 `@` 项目路径引用上限。放在这里是因为两端都执行它：
 * composer 停加 chip，宿主拒绝过长的引用列表。
 */
export const MAX_FILE_REFERENCES = 10;

/**
 * 单条 prompt 图片附件上限，两端同样执行（同 `MAX_FILE_REFERENCES`）。
 * 刻意不做设置：它限定的是一条消息不是能力，且每个附件的体积已由宿主封顶。
 */
export const MAX_IMAGE_ATTACHMENTS = 8;

/**
 * `piAgentChat.transcript.foldLines` 的默认值。放这里是因为三处必须一致：
 * manifest 默认值、向 webview 推值的宿主、首次推送前 webview 的兜底。消息
 * 气泡超过该行数即折叠为预览（无换行长文本按固定每行字符数折算，见
 * `webview/format.ts`）；`0` 为永不折叠。
 */
export const DEFAULT_FOLD_LINES = 14;

// CLI 风格的 footer 统计（镜像 pi TUI 状态行）。
export interface ChatStats {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** 缓存命中率百分比（0-100），无缓存时省略。 */
  cacheHitPercent?: number;
  cost: number;
  /** 上下文窗口占用百分比（0-100），可知时。 */
  contextPercent?: number;
  contextWindow?: number;
}

/**
 * 本扩展在 pi 自带工具之外新增的 subagent 工具名。
 *
 * 刻意用生态里耳熟的 `subagent`：模型一看就知用途。该名字在本窗口归插件——
 * 注册同名工具的扩展被屏蔽（见 `SubagentSetup`），工具要么是本窗口的要么不
 * 存在，绝不落到扩展那份。跨宿主 resume 是尽力兼容（见 AGENTS.md）：自带
 * `subagent` 扩展的 CLI 可能会看到模型模仿这里记录的调用形状。
 */
export const SUBAGENT_TOOL = "subagent";

/**
 * 本扩展新增的终端工具名。
 *
 * 用前缀而非裸 `terminal`：插件认领的每个工具名字都会屏蔽同名扩展工具（见
 * `ToolSetup`），选低碰撞率的名字是守住承诺最省事的办法；前缀也让会话
 * 在别处被读时，名字自己说明它属于哪个宿主。
 */
export const VSCODE_TERMINAL_TOOL = "vscode_terminal";

/**
 * 屏幕上的会话对本宿主某个自有工具的装配情况。
 *
 * 两个值一起传是因为措辞同时依赖两者：屏蔽扩展的提示必须知道本窗口自己的
 * 工具是否顶上；没有被屏蔽者时，关闭的工具也值得一条指向设置的提示——两个
 * 功能默认关，否则永远看不见。
 */
export interface ToolSetup {
  /** 本窗口的工具是否属于本会话工具集。 */
  enabled: boolean;
  /** 注册了被屏蔽同名工具的 pi 扩展路径。 */
  shadowedExtension?: string;
}

/** `ToolSetup` 的历史名，为 subagent 调用点保留。 */
export type SubagentSetup = ToolSetup;

/** 一次运行中的 `subagent` 调用里的一路子代理。 */
export interface DelegationLane {
  id: string;
  title: string;
  // 该子代理可写的路径（相对工作目录）。
  scope: string[];
  status: "running" | "completed" | "failed" | "stopped";
  /**
   * 该子代理此刻在做什么，一行。
   *
   * 父代理等待期间没有输出，UI 的全部活跃感都由这些行承担。
   */
  progress?: string;
  /** 到目前为止经 `edit`/`write` 写过的文件。 */
  writtenFiles: string[];
  /** 跑过 shell 命令即置真；shell 的写入不被追踪。 */
  bashMayHaveWritten?: boolean;
  /** 因越出 `scope` 被拒的写入次数。 */
  scopeViolations?: number;
  /** 被拒的是哪些文件；光有计数说不出还剩什么没做。 */
  deniedPaths?: string[];
  sessionId?: string;
  sessionFile?: string;
  durationMs?: number;
}

/**
 * 当前显示会话视角下的子代理委派。
 *
 * 运行中出现在父会话上；查看某一路时出现在那一 lane 上——包括运行结束后，
 * 用户不会正读着 transcript 就被拽走。
 */
export interface DelegationState {
  /** 显示的是父会话还是某路子代理的 transcript。 */
  role: "parent" | "child";
  lanes: DelegationLane[];
  /** `role` 为 `child` 时：屏上是哪一路。 */
  currentLaneId?: string;
  /** 运行仍在进行时为真。 */
  running: boolean;
  // 用户在 lane 里时父会话有了新进展；用于给返回入口打标，而不是替用户切视图。
  parentHasNewActivity?: boolean;
}

/**
 * 渲染进 webview header/footer 的完整运行时状态快照。宿主每条 `state` 消息
 * 整体替换前一份；可选字段省略即有意清除其 UI 状态。
 */
export interface ChatState {
  ready: boolean;
  cwd?: string;
  sessionFile?: string;
  sessionId?: string;
  /** 用户设置的显示名，回退到首条用户消息。 */
  sessionName?: string;
  modelId?: string;
  providerId?: string;
  thinkingLevel?: string;
  /** 当前模型接受的思考等级，按 SDK 顺序。只有一条（或没有）即等级固定，composer 隐藏选择器。 */
  thinkingLevels?: string[];
  isStreaming: boolean;
  /** 手动/自动上下文压缩进行中；提交排队到结束。 */
  isCompacting: boolean;
  /** 没有任何供应商可用认证时为真：显示设置页而不是聊天。 */
  needsAuth?: boolean;
  /** 会话内消息数（0 = 全新空会话）。 */
  messageCount?: number;
  /** 子代理委派运行中或被查看时出现。 */
  delegation?: DelegationState;
  /** 只读回放历史子代理会话文件时出现。 */
  preview?: { file: string; title: string };
  /** 子代理 transcript 只读：用户只与父代理对话。 */
  inputDisabled?: boolean;
  stats?: ChatStats;
  error?: string;
}

/**
 * composer 快捷模型菜单的一行，只够识别模型：带能力详情、⭐ 与 📌 的完整
 * 列表在「其他模型」背后的原生选择器里。
 */
export interface ModelOption {
  provider: string;
  id: string;
}

// 快捷切换可选的模型：配置顺序的常用模型，未设范围时为全部已认证模型。
export interface ModelCatalog {
  items: ModelOption[];
}

export interface ProjectFileItem {
  /** 相对工作区的路径，恒用正斜杠、无尾斜杠。 */
  path: string;
  kind: "file" | "directory";
  ignored?: boolean;
  sensitive?: boolean;
}

export interface SessionListItem {
  file: string;
  title: string;
  timestamp?: string;
  /** 该会话当前显示在聊天视图时为真。 */
  current?: boolean;
  /** 该会话对应运行中的 runtime 会话时为真。 */
  running?: boolean;
  /** 任务线角色：运行中的子代理或等待中的父会话。 */
  delegationRole?: "parent" | "child";
  /**
   * 该会话被别的顶层 controller 持有。两种状态都可点击：owner 搬到请求方
   * surface、不造第二个 writer；可见的来源面换上一个空的新会话。
   */
  claimedElsewhere?: "visible" | "background";
}


/**
 * CLI 风格启动清单的一节（[Context] / [Skills] / [Prompts] / [Extensions] /
 * [Tools]），渲染为 transcript 顶部的折叠卡片。CLI 的 [Themes] 无 GUI 对应：
 * webview 用 VS Code 主题变量渲染、从不加载 pi 主题。只列 pi 自有的资源
 * 类型；单个扩展的目录约定不进面板。
 */
export interface ResourceSection {
  name: string;
  /** 该节的行，按标签排序；webview 按 scope 分组。 */
  items: ResourceItem[];
}

/**
 * 资源来源。webview 按它分组各节而不是给每行打标，行只带自己的名字。
 * `builtin` 指随 pi 或本扩展发布的东西：代码而非用户写的文件。
 */
export type ResourceScope = "builtin" | "global" | "project" | "package" | "other";

/** 资源节的一行。 */
export interface ResourceItem {
  /** 紧凑标签（技能名、`/prompt` 名、文件名）。 */
  label: string;
  // 点击时打开的绝对路径；不打开任何东西的行没有。
  path?: string;
  /** 展开行里替代 `label` 的文本，如扩展加载错误。 */
  detail?: string;
  /** 额外 tooltip 文本，如工具描述。 */
  hint?: string;
  /**
   * 宿主视角下本会话中生效过：随请求发出的上下文文件、handler 跑过或失败的
   * 扩展。webview 补充它自己看得见的（技能加载、工具调用、模板与扩展命令）；
   * 任一侧说生效即高亮。见 `agent/activity.ts`。
   */
  used?: boolean;
  /**
   * 会话知道但未生效：不在激活集里的已注册工具、加载失败的扩展。置灰而非
   * 隐藏，好回答「是关了还是没有」。其余行都在生效，用常规前景色渲染。
   */
  inactive?: boolean;
  scope: ResourceScope;
}

/**
 * 工具调用对技能的归属，宿主侧用工具参数匹配已加载技能路径得出。`load` 指
 * 读取 `SKILL.md`（模型借此取得技能指示），`resource` 指同技能目录下的其他
 * 文件（脚本、参考）。
 */
export interface SkillRef {
  name: string;
  kind: "load" | "resource";
}

/**
 * 扩展经 `ctx.ui.setStatus(key, text)` 发布的一条状态。
 *
 * SDK 宿主把它渲染在 CLI footer；侧边栏的对应面是状态行。`key` 是扩展自己
 * 的标识，只用于替换/清除它上一条——插件从不解读它。
 */
export interface ExtensionStatusItem {
  key: string;
  text: string;
}

/**
 * 扩展经 `ctx.ui.setWidget()` 发布的一块行。
 *
 * 只有 SDK 的 `string[]` 重载过这条协议；`(tui, theme) => Component` 工厂是
 * TUI 专属表面，本宿主刻意不实现（AGENTS.md 第 1 类），这类调用在宿主侧被
 * 丢弃而不是转发。
 */
export interface ExtensionWidget {
  key: string;
  lines: string[];
  /** 镜像 SDK 的 `WidgetPlacement`，相对 composer。 */
  placement: "aboveEditor" | "belowEditor";
}

/**
 * transcript 消息携带的一张图片，已在宿主侧处理好（转换/缩放），webview 可
 * 直接从 `data:` URL 渲染——webview CSP 允许它。
 */
export interface TranscriptImage {
  mimeType: string;
  /** base64，不带 `data:` 前缀。 */
  data: string;
  // 显示名，如拖入文件的名字。
  name?: string;
}

/** `/` 补全列表的一项。 */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  kind: "builtin" | "prompt" | "extension" | "skill";
}
