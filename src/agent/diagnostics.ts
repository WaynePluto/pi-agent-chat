/**
 * 自检注册表。下面的 `DIAGNOSTIC_SUITES` 是新自检唯一的注册点；套件
 * 本体在 `./diagnostics/` 里，由本文件末尾再导出。
 */
import { runProjectFilesTest, runSessionTreeTest, runSlashCommandTest } from "./diagnostics/commands.js";
import { runExtensionCommandContextTest, runExtensionReloadTest, runExtensionSdkImportTest } from "./diagnostics/extensions.js";
import { runHistoryReplayTest, runManualRetryTest, runReplayedRetryOfferTest, runRetryOfferLifecycleTest } from "./diagnostics/history-retry.js";
import { runImageAttachmentTest, runLiveToolCallTest, runResourceListingTest } from "./diagnostics/resources.js";
import { runSubagentToolTest } from "./diagnostics/subagent.js";
import { runSurfaceCoordinationTest } from "./diagnostics/surface.js";
import { runSpikeDiagnostics } from "./diagnostics/spike.js";
import { runTerminalToolTest } from "./diagnostics/terminal.js";
import { runSessionOwnershipTest, runStartupSessionTest, runViewStateTest } from "./diagnostics/view-sessions.js";

export interface DiagnosticResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * 全部离线自检，按运行顺序排列。
 *
 * 唯一的一份清单。两个运行器——`piAgentChat.runSpikeDiagnostics` 命令与
 * `scripts/smoke_load.mjs`（`pnpm verify` 执行）——都遍历它，加一项自检
 * 只改这里一处。它曾拆在四份拷贝里，漏改一处的后果是新自检在
 * `pnpm verify` 里静默不跑——而 verify 的绿色是本项目唯一的安全网。
 *
 * 实时 LLM 检查刻意缺席：它花 token 且要显式选入。
 */
export const DIAGNOSTIC_SUITES: ReadonlyArray<(cwd: string) => DiagnosticResult[] | Promise<DiagnosticResult[]>> = [
  // SDK 加载、undici alias、jiti、剪贴板：bundle 自身的管线。
  () => runSpikeDiagnostics(),
  runSurfaceCoordinationTest,
  runHistoryReplayTest,
  runSlashCommandTest,
  // 钉住失败请求通知上「重试」动作所依赖的 SDK 私有入口，以及 resume
  // 重发请求时不编造用户消息。
  runManualRetryTest,
  // 钉住同一提议在从磁盘回放的 transcript 上的样子：重开一个死在请求
  // 中途的会话，不能把用户留在一个死胡同里。
  runReplayedRetryOfferTest,
  // 钉住提议被点击后的去向：按钮画自宿主记在通知上的状态，重试结束就
  // 不再声称运行中，回放也不会复活一个已用过的提议。
  runRetryOfferLifecycleTest,
  runSessionTreeTest,
  runSubagentToolTest,
  // 用脚本化的终端 API 钉住终端工具的拒绝路径：没有 shell integration
  // 必须拒绝而不是报空成功，未完成的命令不能被 kill，`close` 碰不到
  // 工具没创建的终端。
  runTerminalToolTest,
  runProjectFilesTest,
  // 必须在 bundle 里跑：它证明重建的 `import.meta.url` 仍能让 SDK 给
  // jiti 可用的 alias（见 sdkModuleUrlPlugin）。
  runExtensionSdkImportTest,
  // 钉住重载资源会重建会话的 extension runner，而不是停留在先前加载的
  // 实例上。
  runExtensionReloadTest,
  // 钉住扩展命令 handler 真能驱动会话（`ctx.newSession()` 一类是宿主
  // 提供的，不是 SDK 默认）。
  runExtensionCommandContextTest,
  runResourceListingTest,
  // 经真实 ChatBridge 钉住宿主侧视图状态机：webview 显示什么
  // （live / lane / preview）及从它派生的全部标志。手搭的 ChatState
  // 快照看不见构建它的代码里的 bug。
  runViewStateTest,
  // 钉住子代理运行期间谁拥有会话文件：所有权与任务线角色来自 runtime，
  // 不是屏幕上的 transcript。
  runSessionOwnershipTest,
  // 钉住窗口启动打开哪个会话：记住的那个，包括没在磁盘留文件、
  // 新建且仍为空的状态。
  runStartupSessionTest,
  // 钉住图片附件路径的端到端：photon/WASM 与 resize worker 必须真的在
  // bundle 里跑起来，纯附件消息必须保持两个 transcript 投影对齐，所有
  // 界面必须经同一投影给会话定标题。
  runImageAttachmentTest,
];

/** 跑全部离线自检。 */
export async function runAllDiagnostics(cwd: string): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];
  for (const suite of DIAGNOSTIC_SUITES) results.push(...(await suite(cwd)));
  return results;
}

export function formatDiagnostics(results: DiagnosticResult[]): string {
  const lines = ["# Pi Agent Chat - Spike Diagnostics", ""];
  for (const result of results) {
    lines.push(`${result.ok ? "[ok]  " : "[fail]"} ${result.name}: ${result.detail}`);
  }
  return lines.join("\n");
}

export {
  runSpikeDiagnostics,
  runSurfaceCoordinationTest,
  runHistoryReplayTest,
  runManualRetryTest,
  runReplayedRetryOfferTest,
  runRetryOfferLifecycleTest,
  runSlashCommandTest,
  runSessionTreeTest,
  runProjectFilesTest,
  runSubagentToolTest,
  runTerminalToolTest,
  runExtensionSdkImportTest,
  runExtensionReloadTest,
  runExtensionCommandContextTest,
  runViewStateTest,
  runSessionOwnershipTest,
  runStartupSessionTest,
  runResourceListingTest,
  runLiveToolCallTest,
  runImageAttachmentTest,
};
