/**
 * 本宿主在 pi 自带工具之外新增的终端工具名。
 *
 * 用前缀而不是裸的 `terminal`：一是扩展生态里碰撞更少——插件认领的名字要么
 * 解析到自己的工具要么不存在，选没人抢的名字最省事；二是跨宿主自解释——在
 * 没有这个工具的 CLI 里 resume 会话时，名字本身就说明了它属于哪个宿主。
 */
export const VSCODE_TERMINAL_TOOL = "vscode_terminal";

/**
 * 新建终端等待 shell integration 的时长。
 *
 * 真机探针在热机上测得约 590ms；预算给得宽裕，因为等不到的替代方案是干脆
 * 拒绝执行命令。
 */
export const SHELL_INTEGRATION_TIMEOUT_MS = 10_000;

/** 等待 `TerminalState.shell` 的时长（该字段异步填充）。 */
export const SHELL_TYPE_TIMEOUT_MS = 5_000;

export const DEFAULT_TIMEOUT_SECONDS = 30;

/**
 * `timeoutSeconds` 的上限。
 *
 * 超时从不 kill 命令，所以这个界不是为命令设的，是为被挡在单次工具调用里的
 * agent 设的：五分钟够装依赖与构建，又不至于让会话停在一个没人看的提示符上
 * 直到永远。
 */
export const MAX_TIMEOUT_SECONDS = 300;

/** 推送到工具卡片的实时进度更新的最小间隔。 */
export const PROGRESS_INTERVAL_MS = 250;

/** integration 只报成功/失败的 shell 类型（见 `describeExit`）。 */
export const BOOLEAN_EXIT_SHELLS = new Set(["pwsh", "powershell"]);
