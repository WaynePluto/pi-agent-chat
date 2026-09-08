/**
 * webview 资源面板展示的资源清单。
 *
 * 对会话 `ResourceLoader` 的纯投影：无 VS Code API、无 bridge 状态，
 * 离线诊断因此能从裸会话构建清单。从 `bridge.ts` 拆出——后者只为了
 * post 结果才 import 它。
 */

import { basename, isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ResourceItem, ResourceScope, ResourceSection } from "../shared/protocol.js";
import type { ResourceActivity } from "./activity.js";

/**
 * 清单需要的运行时信息。取结构而非 `PiRuntime` 类型，离线诊断可以
 * 只传一个裸会话。
 */
export interface ResourceHost {
  session: AgentSession;
  cwd: string;
}

/**
 * 从会话的 resource loader 构建 CLI 风格的启动清单，对齐
 * `interactive-mode` 的 [Context] / [Skills] / [Prompts] / [Extensions]
 * 各栏，外加 CLI 没有对应物的 [Tools] 栏。空栏省略；[Themes] 不列：
 * webview 用 VS Code 主题变量，pi 主题在这里没有效果。
 *
 * 只列 pi 自己的资源类型：单个扩展发明的目录约定（如
 * `~/.pi/agent/agents/`）pi 没有加载器，列出来等于把扩展私有布局呈现成
 * 一等概念。`activity` 给本会话生效过的行打标；诊断不传它。
 */
export function collectResourceSections(runtime: ResourceHost, activity?: ResourceActivity): ResourceSection[] {
  const loader = runtime.session.resourceLoader;
  const sections: ResourceSection[] = [];
  // 每一行都能在编辑器里打开，所以只显示名字（路径留在行的 tooltip）；
  // 归属地驱动 webview 的分组。
  const entry = (name: string, path: string, sourceInfo?: { origin?: string }) => resourceEntry(name, path, runtime.cwd, sourceInfo);

  const systemPromptSource = loader.getSystemPromptSource();
  const contextFiles = [
    ...(systemPromptSource ? [systemPromptSource] : []),
    ...loader.getAppendSystemPromptSources(),
    ...loader.getAgentsFiles().agentsFiles,
  ];
  if (contextFiles.length > 0) {
    // Context 文件每次请求都拼进 system prompt，从首次请求起就
    // 整体一起生效。
    sections.push(
      sortedSection(
        "Context",
        contextFiles.map((file) => ({ ...entry(basename(file.path), file.path), ...(activity?.contextUsed ? { used: true } : {}) })),
      ),
    );
  }

  const skills = loader.getSkills().skills;
  if (skills.length > 0) {
    sections.push(sortedSection("Skills", skills.map((skill) => entry(skill.name, skill.filePath, skill.sourceInfo))));
  }

  const prompts = loader.getPrompts().prompts;
  if (prompts.length > 0) {
    sections.push(sortedSection("Prompts", prompts.map((prompt) => entry(`/${prompt.name}`, prompt.filePath, prompt.sourceInfo))));
  }

  const { extensions: allExtensions, errors: extensionErrors } = runtime.session.resourceLoader.getExtensions();
  const extensions = allExtensions.filter((extension) => !extension.hidden);
  if (extensions.length > 0 || extensionErrors.length > 0) {
    sections.push(
      sortedSection("Extensions", [
        ...extensions.map((extension) => ({
          ...entry(basename(extension.path), extension.path, (extension as { sourceInfo?: { origin?: string } }).sourceInfo),
          ...(activity?.isExtensionUsed(extension.path) ? { used: true } : {}),
        })),
        // 加载失败的扩展没有可打开的文件，错误文本即行文本，并置灰：
        // 已配置但未生效。
        ...extensionErrors.map((failure) => ({
          label: `${basename(failure.path)} (load failed)`,
          detail: `${failure.path}: ${String(failure.error)}`,
          inactive: true,
          scope: resourceScope(failure.path, runtime.cwd),
        })),
      ]),
    );
  }

  const tools = collectToolItems(runtime);
  if (tools.length > 0) {
    sections.push(sortedSection("Tools", tools));
  }

  return sections;
}

/**
 * 会话已配置的全部工具，无论激活与否。
 *
 * pi 注册七个内置工具但只激活 `read`/`bash`/`edit`/`write`
 * （`core/sdk.ts`），`grep`/`find`/`ls` 在这里显示为未激活，直到某个扩展
 * 打开它们——这正是该行要回答的问题。内置与 SDK 提供的工具带合成的
 * `<builtin:read>` 路径、点了不打开；扩展注册的工具保留该扩展的文件，
 * 行因此指向提供者。
 */
function collectToolItems(runtime: ResourceHost): ResourceItem[] {
  const session = runtime.session;
  const active = new Set(session.getActiveToolNames());
  return session.getAllTools().map((tool) => {
    const sourceInfo = tool.sourceInfo as { path?: string; origin?: string } | undefined;
    const path = sourceInfo?.path && !sourceInfo.path.startsWith("<") ? sourceInfo.path : undefined;
    const hint = tool.description?.split("\n").find((line) => line.trim())?.trim();
    return {
      label: tool.name,
      scope: path ? resourceScope(path, runtime.cwd, sourceInfo) : ("builtin" as const),
      ...(path ? { path } : {}),
      ...(hint ? { hint } : {}),
      ...(active.has(tool.name) ? {} : { inactive: true }),
    };
  });
}

/**
 * 构建一栏清单，按标签排序。行携带 scope 供 webview 分组
 * （先全局后项目），而不是给每行贴来源标签。
 */
function sortedSection(name: string, items: ResourceItem[]): ResourceSection {
  return { name, items: [...items].sort((a, b) => a.label.localeCompare(b.label)) };
}

/**
 * 一行清单：资源名做行文本，背后的文件做点击/tooltip 目标。
 */
function resourceEntry(name: string, path: string, cwd: string, sourceInfo?: { origin?: string }): ResourceItem {
  if (!path) return { label: name, scope: "other" };
  return { label: name, path, scope: resourceScope(path, cwd, sourceInfo) };
}

/**
 * 资源来自哪里，用 SDK 文档（`docs/skills.md`）的口径。
 * `sourceInfo.scope` 不能直接用：`~/.agents/skills` 或项目
 * `.agents/skills` 下的技能不属于 SDK 的 "user"/"project" 任一根，会被
 * 归成 "temporary"，所以按位置分类。
 */
function resourceScope(filePath: string, cwd: string, sourceInfo?: { origin?: string }): ResourceScope {
  if (sourceInfo?.origin === "package") return "package";
  const path = resolvePath(filePath);
  if (isInside(path, cwd)) return "project";
  if (isInside(path, homedir())) return "global";
  return "other";
}

function isInside(path: string, root: string): boolean {
  const relative = relativePath(root, path);
  return relative !== "" && !relative.startsWith("..") && !isAbsolute(relative);
}
