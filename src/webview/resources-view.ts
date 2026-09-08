import type { ResourceItem, ResourceScope, ResourceSection } from "../shared/protocol.js";
import { RESOURCES_CLASSES, RESOURCE_SECTION_CLASSES, createCollapsible } from "./collapsible.js";
import { button, el } from "./dom.js";
import { post } from "./host.js";
import { getDict } from "./i18n.js";
import { resourcesEl } from "./shell.js";

/**
 * CLI 风格的启动清单（[Context]/[Skills]/[Tools]/…）：窄模式是 transcript
 * 上方的带框面板，宽模式是常驻右栏。可见性与顶层展开按布局模式分成两份
 * （浮层与停靠栏是不同的表面，「别挡住消息」与「要有这条栏」是两个愿
 * 望），切换恢复各自状态、互不继承；用户显式开合过的 section 共享该决定
 * （内容偏好与布局无关），没碰过的才落当前模式默认值。
 * 配色回答「本会话里真的生效了吗」：生效过的着色、已配置未生效的置灰；
 * 绿色是两个来源的并集——transcript 可见的与仅宿主可见的 item.used
 * （见 agent/activity.ts）。
 */

const t = getDict();

/** 行高亮可由当前显示的 transcript 驱动的 section。 */
const CONTEXT_SECTION = "Context";
const SKILLS_SECTION = "Skills";
const TOOLS_SECTION = "Tools";
const PROMPTS_SECTION = "Prompts";
const EXTENSIONS_SECTION = "Extensions";

/**
 * section 内 scope 分组的显示顺序：先随 agent 自带的，再跨项目共享的，
 * 最后本工作区的。行本身不带 scope 标签，「它从哪来」由分组标题回答。
 */
const SCOPE_ORDER: readonly ResourceScope[] = ["builtin", "global", "project", "package", "other"];

/**
 * 面板可见性与顶层展开，按布局模式分别保存。
 *
 * **两种模式都不默认显示**：宽屏阈值过去会自动打开这条栏，让一次窗口
 * resize 在用户背后重排界面；阈值现在只让栏「成为可能」，开没开过由
 * 外壳记忆（webview/main.ts 持久化），不在这里给默认。
 *
 * 展开默认值两级都按模式不同，理由同上：特意打开的栏收着就没东西可看，
 * 故逐层全展开；窄屏浮层压在 transcript 上，起手一行摘要、逐层打开。
 */
const panelState = {
  narrow: { shown: false, expanded: false, sectionsExpanded: false },
  wide: { shown: false, expanded: true, sectionsExpanded: true },
};
let panelMode: keyof typeof panelState = "narrow";
const panel$ = () => panelState[panelMode];
/**
 * 用户显式开合过的 section。缺省表示「没碰过」，回落当前模式默认值；记
 * 决定而非状态，两个模式才能各有默认值而不吃掉用户的选择。高亮触发的
 * 整体重渲染后仍然有效。
 */
const sectionExpansion = new Map<string, boolean>();
let lastSections: ResourceSection[] = [];
/** 当前显示的 transcript 中加载的技能 / 调用过的工具；切换时重置。 */
const usedSkills = new Set<string>();
const usedTools = new Set<string>();
/** 当前显示的 transcript 中调用过的提示词模板名。 */
const usedPrompts = new Set<string>();
/** 当前显示的 transcript 中跑过命令的扩展的绝对路径。 */
const usedExtensions = new Set<string>();

export function renderResources(sections: ResourceSection[]): void {
  lastSections = sections;
  resourcesEl.replaceChildren();
  if (sections.length === 0) return;

  const panel = createCollapsible({
    classes: RESOURCES_CLASSES,
    rootClass: "resources-panel",
    label: t.resourcesLoaded,
    status: sections.map((section) => `${section.name} ${section.items.length}`).join(" · "),
    expanded: panel$().expanded,
    parent: resourcesEl,
    onToggle: (expanded) => {
      panel$().expanded = expanded;
    },
  });

  for (const section of sections) {
    const block = createCollapsible({
      classes: RESOURCE_SECTION_CLASSES,
      rootClass: "resource-section",
      label: `[${section.name}]`,
      status: section.items.map((item) => item.label).join(", "),
      expanded: sectionExpansion.get(section.name) ?? panel$().sectionsExpanded,
      parent: panel.body,
      onToggle: (expanded) => {
        sectionExpansion.set(section.name, expanded);
      },
    });
    // 用过的着色、关掉的置灰，而不是加前缀——摘要行仍读作一个普通的
    // 逗号分隔列表。
    if (section.items.some((item) => item.inactive || isUsed(section.name, item))) {
      block.statusEl.replaceChildren(...summaryNodes(section));
    }
    for (const scope of SCOPE_ORDER) {
      const rows = section.items.filter((item) => item.scope === scope);
      if (rows.length === 0) continue;
      block.body.appendChild(el("div", "resource-scope", t.resourceScopes[scope]));
      for (const item of rows) block.body.appendChild(resourceRow(item, section.name));
    }
  }
}

function summaryNodes(section: ResourceSection): Node[] {
  const nodes: Node[] = [];
  section.items.forEach((item, index) => {
    if (index > 0) nodes.push(document.createTextNode(", "));
    const highlight = isUsed(section.name, item) ? "resource-used" : item.inactive ? "resource-inactive" : undefined;
    nodes.push(highlight ? el("span", highlight, item.label) : document.createTextNode(item.label));
  });
  return nodes;
}

/**
 * 切到目标布局模式自己的面板状态。每次宽窄切换都调用而不是只在启动时：
 * 可见性与展开默认值都归模式所有，面板要用进入方的状态重建。
 */
export function setResourcesLayout(wide: boolean): void {
  const mode = wide ? "wide" : "narrow";
  if (mode === panelMode) return;
  panelMode = mode;
  if (lastSections.length > 0) renderResources(lastSections);
}

/** 不经用户开关，直接恢复记忆的栏状态。 */
export function setResourcesShown(shown: boolean): void {
  panel$().shown = shown;
}

/** header 开关：把整个面板在当前布局中开 / 关。 */
export function toggleResources(): void {
  panel$().shown = !panel$().shown;
}

/** 用户是否要求显示面板；真正可见还需 `hasResources()`。 */
export function isResourcesShown(): boolean {
  return panel$().shown;
}

/** 记录当前 transcript 中加载过一个技能。 */
export function markSkillActive(name: string): void {
  if (usedSkills.has(name)) return;
  usedSkills.add(name);
  rerenderIfPresent(SKILLS_SECTION);
}

/** 记录当前 transcript 中调用过一个工具。 */
export function markToolUsed(name: string): void {
  if (usedTools.has(name)) return;
  usedTools.add(name);
  // 注册该工具的扩展随之点亮；关联是共享的文件路径，渲染时推导，不在
  // 这里另存。
  rerenderIfPresent(TOOLS_SECTION);
}

/** 记录当前 transcript 中调用过一个提示词模板。 */
export function markPromptUsed(name: string): void {
  if (usedPrompts.has(name)) return;
  usedPrompts.add(name);
  rerenderIfPresent(PROMPTS_SECTION);
}

/** 记录当前 transcript 中跑过一个扩展命令。 */
export function markExtensionUsed(path: string): void {
  if (usedExtensions.has(path)) return;
  usedExtensions.add(path);
  rerenderIfPresent(EXTENSIONS_SECTION);
}

/** 显示别的 transcript 时清掉「本处生效过」标记。 */
export function clearResourceHighlights(): void {
  if (usedSkills.size === 0 && usedTools.size === 0 && usedPrompts.size === 0 && usedExtensions.size === 0) return;
  usedSkills.clear();
  usedTools.clear();
  usedPrompts.clear();
  usedExtensions.clear();
  if (lastSections.length > 0) renderResources(lastSections);
}

function rerenderIfPresent(sectionName: string): void {
  if (lastSections.some((section) => section.name === sectionName)) renderResources(lastSections);
}

/** 有值得显示的内容时为真；驱动面板可见性。 */
export function hasResources(): boolean {
  return resourcesEl.hasChildNodes();
}

function isUsed(sectionName: string, item: ResourceItem): boolean {
  // transcript 看不到的部分，宿主已判定。
  if (item.used) return true;
  if (sectionName === SKILLS_SECTION) return usedSkills.has(item.label);
  if (sectionName === TOOLS_SECTION) return usedTools.has(item.label);
  // 提示词行带用户输入的 `/name` 形式。
  if (sectionName === PROMPTS_SECTION) return usedPrompts.has(item.label.replace(/^\//, ""));
  if (sectionName === EXTENSIONS_SECTION) return item.path !== undefined && isExtensionUsed(item.path);
  return false;
}

/**
 * 扩展的命令跑过、或它注册的工具被调用过，即算生效：工具行携带注册扩展
 * 的文件路径，与扩展行打开的是同一路径。
 */
function isExtensionUsed(path: string): boolean {
  if (usedExtensions.has(path)) return true;
  const tools = lastSections.find((section) => section.name === TOOLS_SECTION)?.items ?? [];
  return tools.some((tool) => tool.path === path && usedTools.has(tool.label));
}

/** 该行为何高亮，用其所属 section 自己的措辞说明。 */
function usedTitle(sectionName: string, label: string): string {
  if (sectionName === CONTEXT_SECTION) return t.contextUsedTitle;
  if (sectionName === SKILLS_SECTION) return t.skillActiveTitle(label);
  if (sectionName === PROMPTS_SECTION) return t.promptUsedTitle;
  if (sectionName === EXTENSIONS_SECTION) return t.extensionUsedTitle;
  return t.toolUsedTitle;
}

function resourceRow(item: ResourceItem, sectionName: string): HTMLElement {
  // 带文件的行点击后在编辑器打开；错误行与内置工具保持纯文本。
  const used = isUsed(sectionName, item);
  const text = item.detail ?? item.label;
  const modifiers = [used ? "resource-used" : "", item.inactive ? "resource-inactive" : ""].filter(Boolean);
  // 提示：先是什么、再在本会话中的状态、最后点击会做什么。
  const notes = [item.hint];
  if (item.inactive) notes.push(t.resourceInactiveTitle);
  else if (used) notes.push(usedTitle(sectionName, item.label));
  const lines = notes.filter(Boolean) as string[];
  if (!item.path) {
    const row = el("div", modifiers.join(" ") || undefined, text);
    if (lines.length > 0) row.title = lines.join("\n");
    return row;
  }
  const target = item.path;
  const row = button(["resource-file", ...modifiers].join(" "), text, () => post({ type: "openFile", path: target }));
  row.title = [...lines, `${target}\n${t.resourceOpenTitle}`].join("\n");
  return row;
}
