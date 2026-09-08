/**
 * 两向消息联合（宿主 → webview 的 `HostMessage`、webview → 宿主的
 * `WebviewMessage`）与其载荷的 transcript 事件投影。数据形状在
 * `./types.ts`；同母亲模块零依赖。
 */
import type {
  ChatState,
  ExtensionStatusItem,
  ExtensionWidget,
  JsonValue,
  ModelCatalog,
  ProjectFileItem,
  ResourceSection,
  SessionListItem,
  SkillRef,
  SlashCommand,
  SubagentSetup,
  ToolSetup,
  TranscriptImage,
} from "./types.js";

/** `AgentSessionEvent` 的简化可序列化投影。 */
export type ChatEvent =
  /**
   * `skill` / `prompt` / `extension` 把消息归属到它调用的资源，资源面板据此
   * 点亮那一行（见 `agent/invocations.ts`）。`extension` 带提供方扩展的绝对
   * 路径，与其资源行打开的值相同。
   */
  | { kind: "user_message"; text: string; mode?: "steer" | "followUp"; skill?: string; prompt?: string; extension?: string; images?: TranscriptImage[] }
  | { kind: "assistant_start" }
  | { kind: "text_delta"; delta: string }
  | { kind: "thinking_delta"; delta: string }
  /** 完整的 assistant 文本，回放会话历史时用。 */
  | { kind: "assistant_message"; text: string }
  /** 历史里的完整思考文本，渲染为折叠卡片。 */
  | { kind: "thinking_message"; text: string }
  | { kind: "assistant_end" }
  | { kind: "tool_start"; id: string; name: string; args: unknown; skill?: SkillRef }
  /**
   * 仍在运行的工具的部分结果。
   *
   * `details` 带工具自己的实时载荷；子代理卡片正是用它画的，各子代理行才能
   * 在调用期间动起来。
   */
  | { kind: "tool_update"; id: string; text: string; details?: JsonValue }
  | {
      kind: "tool_end";
      id: string;
      name: string;
      isError: boolean;
      text: string;
      /** 回放历史时出现（那时还没有 `tool_start` 卡片）。 */
      args?: unknown;
      /** `edit` 工具的统一 patch，用于打开原生 diff 视图。 */
      patch?: string;
      path?: string;
      /** 工具自定义的结构化结果（`AgentToolResult.details`），渲染为通用折叠树。只为无专用卡片的工具携带，且经宿主清洗（见 `agent/tool-details.ts`）。 */
      details?: JsonValue;
      /** 该调用读取或运行了技能的一部分时设置。 */
      skill?: SkillRef;
    }
  | { kind: "agent_start" }
  | { kind: "agent_end" }
  // 自动重试、压缩与排队续跑全部落定。
  | { kind: "agent_settled" }
  | { kind: "queue_update"; steering: string[]; followUp: string[] }
  /** Pi 用摘要替换旧模型上下文时追加的持久标记。 */
  | { kind: "compaction_boundary"; summary: string; tokensBefore: number; estimatedTokensAfter?: number }
  | {
      kind: "status";
      text: string;
      scope?: "command";
      /**
       * 通知报告的是自动重试放弃的那次请求，且被中断的一轮仍可重发。webview
       * 在卡片上画重试动作并让它留在（折叠的）work block 之外：继续只需一次
       * 点击，而不是发一条「继续」——那条消息会进 transcript 与模型上下文。
       * 动作的整个生命周期都在这个宿主持有的字段里：按钮永远按它画、不按本
       * 地点击状态画，重试中途离开再回来，看到的就是离开时的样子。
       */
      retry?: RetryOfferState;
    }
  | { kind: "error"; text: string; scope?: "command" };

/**
 * 通知携带的「重发失败请求」动作的状态。
 *
 * `offered` 是唯一可点击态；其余三个是点击结果，且每次 offer 至多点一次
 * （再次失败的请求会以其新 offer 收尾自己那一轮）。
 */
export type RetryOfferState = "offered" | "running" | "succeeded" | "failed";

/** 扩展宿主 → webview。 */
export type HostMessage =
  | { type: "state"; state: ChatState }
  /**
   * 消息气泡的折叠阈值（`piAgentChat.transcript.foldLines`），在 `ready` 与
   * 设置变化时推送，且总是跟一次历史重放：气泡在构建时决定是否折叠，新阈值
   * 要到达已存在的气泡必须重建 transcript。这是显示配置而非运行时状态，故
   * 在 `ChatState` 之外、且只在变化时传。
   */
  | { type: "foldThreshold"; maxLines: number }
  /**
   * 流式期间思考是否保持展开（`piAgentChat.transcript.showThinking`），
   * `ready` 与设置变化时推送并跟一次历史重放：与折叠阈值同理，卡片在构建时
   * 决定是否展开。显示配置而非运行时状态，在 `ChatState` 之外、只在变化时传。
   */
  | { type: "showThinking"; enabled: boolean }
  /**
   * 居中聊天栏的最大宽度（`piAgentChat.layout.contentMaxWidth`），`ready` 与
   * 设置变化时推送。webview 把它写进 `--content-max-width` 自定义属性
   * （transcript、composer 与宽屏 grid 都按它定尺寸）。纯呈现、不含既定
   * 决策，故与折叠阈值不同、无需历史重放。`wideMinWidth` 随行是因为两者都是
   * webview 自己读不到的布局几何，且首次宽窄判定前就要用。
   */
  | { type: "contentWidth"; maxWidth: number; wideMinWidth: number }
  | { type: "event"; event: ChatEvent }
  /** 启动或会话切换后的完整 transcript 重放。 */
  | {
      type: "history";
      events: ChatEvent[];
      live?: boolean;
      /**
       * 所显示 transcript 的身份（会话 id，预览时为文件）。重建同一 transcript
       * 时 webview 恢复它的视图状态（哪些 work block 展开）——用户每次进出
       * 子代理都会触发一次。
       */
      transcriptId?: string;
      /**
       * 重放的用户消息进 composer 的 ↑/↓ 输入历史，对齐 CLI 初始渲染
       * （`populateHistory: true`）。仅在会话成为 live 时（attach 与
       * `ready`）设置，lane/preview 往返绝不设置：那会重复灌入，且 lane 的
       * 首条「用户消息」是父代理写的任务、不是用户敲的。webview 另按
       * transcript 去重，窗口启动的 attach+ready 双发仍只灌一次。
       */
      populateInputHistory?: boolean;
      // SYSTEM.md 替换了 Pi 默认提示词及随包文档指引时为真。
      systemPromptOverridden?: boolean;
      /**
       * 本会话对 subagent 工具的装配情况：本窗口工具是否启用、哪个扩展的同名
       * 注册因此被弃（名字归本窗口工具；见 `SubagentSetup`）。属新会话提示而
       * 非 transcript 事件：它描述会话怎么装配，不是会话里发生了什么。
       */
      subagent?: SubagentSetup;
      /**
       * 本宿主 `vscode_terminal` 工具的同款信息。单列字段而不并成一个列表：
       * 两者措辞不同，提示必须说清在讲哪个工具。
       */
      terminal?: ToolSetup;
    }
  | { type: "sessions"; items: SessionListItem[] }
  /** 应答 `listModels`；凭据或标记变化后也会推送。 */
  | { type: "models"; catalog: ModelCatalog }
  /** 宿主侧打开 composer 模型选择器（`/model`）。 */
  | { type: "openPicker"; picker: "model" }
  | { type: "commands"; items: SlashCommand[] }
  /** 启动资源清单，固定在 transcript 上方。 */
  | { type: "resources"; sections: ResourceSection[] }
  /** webview `@` 项目路径选择器的结果。 */
  | { type: "projectFiles"; requestId: number; items: ProjectFileItem[]; error?: string }
  /**
   * 一次 `attachImage` 请求的结果。
   *
   * 成功时载荷是*处理后的*图片：composer 缩略图所见即模型所得，原始字节不会
   * 折返。`note` 带用户该知道但不阻塞发送的情况（当前模型不支持读图、共享
   * 设置开了 `blockImages`）。
   */
  | {
      type: "attachment";
      requestId: number;
      id?: string;
      image?: TranscriptImage;
      note?: string;
      error?: string;
    }
  /**
   * 屏上消息气泡的会话树 entry id，按角色、按 transcript 顺序，让每个气泡能
   * 对自己的 entry 操作（切换/分叉/标签）。`ids`/`labels` 绑用户气泡，
   * `assistantIds`/`assistantLabels` 绑 agent 气泡。消息还在排队时比气泡列表
   * 短；不允许对显示中的 transcript 操作时（预览、子代理视图）为空。
   */
  | {
      type: "entryIds";
      ids: string[];
      labels: (string | undefined)[];
      assistantIds: string[];
      assistantLabels: (string | undefined)[];
    }
  /**
   * 整体替换屏上会话的扩展状态与 widget。它们是实时 UI 状态而非 transcript
   * 历史，故在 `history`/`event` 之外传输，显示的会话一变就重发。
   */
  | { type: "extensionStatus"; items: ExtensionStatusItem[] }
  | { type: "extensionWidgets"; items: ExtensionWidget[] }
  /** 预填 composer，如分叉时被切走的那条消息。 */
  | { type: "setInput"; text: string }
  // 排队消息被撤回：移除气泡，文本退回 composer。
  | { type: "dequeued"; texts: string[] }
  | { type: "clear" };

/** webview → 扩展宿主。 */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "prompt"; text: string; references?: string[]; imageIds?: string[]; streamingBehavior?: "steer" | "followUp" }
  | { type: "attachImage"; requestId: number; name?: string; mimeType?: string; data?: string }
  /**
   * 附加用户粘贴进 composer 的图片。
   *
   * 粘贴是唯一路径：窗口里一有拖拽，VS Code 就禁掉所有 webview iframe 的
   * pointer 事件，webview 根本收不到 `drop`；截图与文件管理器复制的文件都走
   * 剪贴板。字节只在 attach 时传一次而非发送时：宿主立即处理（转换/缩放），
   * composer 才能显示真缩略图、在用户还在写时就报拒绝；prompt 之后只带 id。
   */
  /** 发送前再次移除附件。 */
  | { type: "detachImage"; id: string }
  | { type: "listProjectFiles"; requestId: number; query: string; includeIgnored: boolean }
  | { type: "abort" }
  /** 重发失败的请求，不新增用户消息（见 `status.retry`）。 */
  | { type: "retry" }
  /** 清空全部排队（steer/follow-up）消息；文本退回 composer。 */
  | { type: "dequeue" }
  | { type: "newSession" }
  /** 窄屏会话页或宽屏会话栏显隐；仅在可见时扫盘。 */
  | { type: "sessionsVisible"; visible: boolean }
  | { type: "listCommands" }
  | { type: "resumeSession"; file: string }
  /** 把被其他顶层 controller claim 的会话搬到本 surface。 */
  | { type: "revealSession"; file: string }
  /**
   * 在父会话与某路子代理之间切换显示的 transcript。
   *
   * `sessionFile` 与 `title` 让宿主在子会话对象已不在时（如窗口重载后）仍保
   * 持子代理框架：改为重放会话文件，仍呈现为那个子代理而非无关的只读预览。
   */
  | { type: "showLane"; laneId?: string; sessionFile?: string; title?: string }
  /** 停止某一路子代理；其余继续跑，父代理仍拿到汇报。 */
  | { type: "stopLane"; laneId: string }
  /** 删除持久化会话文件（宿主侧确认）。 */
  | { type: "deleteSession"; file: string }
  // 从会话列表重命名（宿主弹输入框；写 session_info 条目）。
  | { type: "renameSession"; file: string }
  /** 在编辑区打开会话文件（不是侧边栏）。 */
  | { type: "openSessionInEditor"; file: string }
  /** 在新浮动窗口打开会话文件。 */
  | { type: "openSessionInNewWindow"; file: string }
  /** 从 header 重命名当前会话，含尚无文件的空会话。 */
  | { type: "renameCurrentSession" }
  /** 打开会话树导航（切分支/分叉/标签）。 */
  | { type: "openSessionTree" }
  /**
   * 同三个操作，作用于 transcript 里的某个消息气泡。entry 自身说明角色，
   * 由宿主——不是 webview——决定各操作对它的含义（见 `forkFromEntry`）。
   */
  | { type: "entryAction"; action: "switch" | "fork" | "label"; entryId: string }
  /** 请求 composer 快捷模型菜单可选的模型。 */
  | { type: "listModels" }
  /** 只切换当前会话的模型。 */
  | { type: "setModel"; provider: string; modelId: string }
  /** 打开原生完整模型选择器（搜索、能力详情、⭐ / 📌）。 */
  | { type: "pickModel" }
  /** 启动供应商登录流程（认证设置页也用）。 */
  | { type: "login" }
  /** 移除登录保存的凭据。 */
  | { type: "logout" }
  | { type: "setThinkingLevel"; level: string }
  // 打开设置菜单（供应商、shell 路径等）。
  | { type: "openSettings" }
  | { type: "openDiff"; path: string; patch: string }
  | { type: "openFile"; path: string }
  /**
   * 复制文本到剪贴板（消息气泡、代码块）。
   *
   * 与 `openFile` 同理归宿主：webview 的 `navigator.clipboard` 受焦点与权限
   * 限制、各宿主表现不一，`vscode.env.clipboard` 处处可用。
   */
  | { type: "copyText"; text: string };
