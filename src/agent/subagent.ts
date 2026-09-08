/**
 * `subagent` 工具：父代理一次工具调用里并行派出多路隔离子会话，各在
 * 声明的可写范围内直接改工作树，逐路记账并向父代理汇报。
 *
 * 桶文件：实现拆在 `./subagent/` 下（类型、模型解析、子会话提示词、
 * 进展投影、汇报文本、工具定义、调度器各一模块），拆分前的全部导出
 * 在此原样再导出，导入方继续用 `./subagent.js`。
 */
export type {
  LaneFailure,
  LaneNotice,
  LaneState,
  LaneStatus,
  SubagentHost,
  SubagentObserver,
  SubagentRun,
} from "./subagent/types.js";
export { SUBAGENT_TOOL } from "./subagent/types.js";
export { planModel } from "./subagent/model.js";
export { SubagentCoordinator } from "./subagent/coordinator.js";
