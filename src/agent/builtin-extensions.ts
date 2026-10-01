import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

/**
 * SDK 0.99 起 CLI 自带的内置扩展（codemode / tool-search / mcp），装载语义
 * 与 CLI 完全一致：`builtin: true` 让它们以 `builtin:<name>` 资源路径默认
 * 启用，共享 `extensions` 设置里的 `-builtin:<name>` 可按用户/项目两级
 * 禁用；`replaceable: true` 让注册了同名工具/命令/标志的扩展顶掉内置版
 * 而不是冲突报错。`mcp.json`、`codemode.mode`、`defaultTools: ["+codemode"]`
 * 等全在共享配置里，插件不做任何自己的策略决定。
 *
 * CLI 还有一个 `llama.cpp` 内置扩展，但其工厂未从 SDK 包根导出
 * （deep import 是红线），暂不可达——已作为上游导出面缺口记录，推动上游
 * 从包根导出完整清单后补齐。
 *
 * SDK-MIRROR: `dist/extensions/index.ts` 的 `builtInExtensions`（CLI 的装载
 * 清单，含 llama.cpp），SDK 升级时对照核对名字与 replaceable/builtin 标记。
 */
export const builtinExtensions: InlineExtension[] = [
  { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
  { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
  { name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
];
