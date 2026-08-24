import type { ResourceItem, ResourceScope, ResourceSection } from "../shared/protocol.js";
import { RESOURCES_CLASSES, RESOURCE_SECTION_CLASSES, createCollapsible } from "./collapsible.js";
import { button, el } from "./dom.js";
import { post } from "./host.js";
import { getDict } from "./i18n.js";
import { resourcesEl } from "./shell.js";

/**
 * CLI-style startup listing ([Context] / [Skills] / [Tools] / ...): a bordered
 * panel above the transcript in narrow mode, and a persistent right rail in
 * wide mode.
 *
 * Initial narrow mode starts hidden/collapsed and initial wide mode starts
 * shown/expanded. After that first choice, visibility and top-level expansion
 * are shared across mode switches; each section also keeps its own state.
 *
 * Two highlights answer "what actually happened in this session?": resources
 * that took effect here are coloured, while rows that are configured but not in
 * effect (a tool outside the active set, an extension that failed to load) are
 * dimmed. Everything else is plain foreground text: loaded and in effect, just
 * not exercised here.
 *
 * The colour has two sources. What the transcript can see is tracked here:
 * skills loaded, tools called, prompt templates and extension commands
 * invoked. What only the host can see arrives as `item.used` (context files
 * that went out with a request, extensions whose handler ran or failed — see
 * `agent/activity.ts`); the two are simply OR-ed.
 */

const t = getDict();

/** Sections whose rows can be highlighted from the displayed transcript. */
const CONTEXT_SECTION = "Context";
const SKILLS_SECTION = "Skills";
const TOOLS_SECTION = "Tools";
const PROMPTS_SECTION = "Prompts";
const EXTENSIONS_SECTION = "Extensions";

/**
 * Display order of the scope groups inside a section: what ships with the
 * agent first, then the resources shared across projects, then the ones this
 * workspace brings in. Rows carry no scope tag of their own; the group heading
 * answers "where is this from?".
 */
const SCOPE_ORDER: readonly ResourceScope[] = ["builtin", "global", "project", "package", "other"];

/** Visibility and top-level expansion are shared across narrow/wide modes. */
let panelShown = false;
let resourcesExpanded = false;
let layoutDefaultsInitialized = false;
/** Section expansion survives full re-renders triggered by the highlights. */
const expandedSections = new Set<string>();
let lastSections: ResourceSection[] = [];
/** Skills loaded / tools called in the displayed transcript; reset on swap. */
const usedSkills = new Set<string>();
const usedTools = new Set<string>();
/** Prompt template names invoked in the displayed transcript. */
const usedPrompts = new Set<string>();
/** Absolute paths of extensions whose command ran in the displayed transcript. */
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
    expanded: resourcesExpanded,
    parent: resourcesEl,
    onToggle: (expanded) => {
      resourcesExpanded = expanded;
    },
  });

  for (const section of sections) {
    const block = createCollapsible({
      classes: RESOURCE_SECTION_CLASSES,
      rootClass: "resource-section",
      label: `[${section.name}]`,
      status: section.items.map((item) => item.label).join(", "),
      expanded: expandedSections.has(section.name),
      parent: panel.body,
      onToggle: (expanded) => {
        if (expanded) expandedSections.add(section.name);
        else expandedSections.delete(section.name);
      },
    });
    // What was used is coloured and what is switched off is dimmed, rather than
    // prefixed, so the summary line keeps reading as a plain comma-separated
    // list.
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
 * Choose defaults once from the initial viewport; later mode switches inherit
 * the same visibility and expansion state instead of resetting either one.
 */
export function initializeResourcesState(wide: boolean): void {
  if (layoutDefaultsInitialized) return;
  layoutDefaultsInitialized = true;
  panelShown = wide;
  resourcesExpanded = wide;
  if (lastSections.length > 0) renderResources(lastSections);
}

/** Header toggle: flip the whole panel in or out of the layout. */
export function toggleResources(): void {
  panelShown = !panelShown;
}

/** Whether the user asked for the panel; visibility also needs `hasResources()`. */
export function isResourcesShown(): boolean {
  return panelShown;
}

/** Record that a skill was loaded in the current transcript. */
export function markSkillActive(name: string): void {
  if (usedSkills.has(name)) return;
  usedSkills.add(name);
  rerenderIfPresent(SKILLS_SECTION);
}

/** Record that a tool was called in the current transcript. */
export function markToolUsed(name: string): void {
  if (usedTools.has(name)) return;
  usedTools.add(name);
  // The extension that registered the tool lights up with it; the link is the
  // shared file path, so it is derived at render time rather than stored here.
  rerenderIfPresent(TOOLS_SECTION);
}

/** Record that a prompt template was invoked in the current transcript. */
export function markPromptUsed(name: string): void {
  if (usedPrompts.has(name)) return;
  usedPrompts.add(name);
  rerenderIfPresent(PROMPTS_SECTION);
}

/** Record that an extension's command ran in the current transcript. */
export function markExtensionUsed(path: string): void {
  if (usedExtensions.has(path)) return;
  usedExtensions.add(path);
  rerenderIfPresent(EXTENSIONS_SECTION);
}

/** Drop the "used here" marks when another transcript is displayed. */
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

/** True when there is something worth showing; drives the panel's visibility. */
export function hasResources(): boolean {
  return resourcesEl.hasChildNodes();
}

function isUsed(sectionName: string, item: ResourceItem): boolean {
  // The host already resolved what the transcript cannot show.
  if (item.used) return true;
  if (sectionName === SKILLS_SECTION) return usedSkills.has(item.label);
  if (sectionName === TOOLS_SECTION) return usedTools.has(item.label);
  // Prompt rows carry the `/name` form the user types.
  if (sectionName === PROMPTS_SECTION) return usedPrompts.has(item.label.replace(/^\//, ""));
  if (sectionName === EXTENSIONS_SECTION) return item.path !== undefined && isExtensionUsed(item.path);
  return false;
}

/**
 * An extension counts as used once one of its commands ran, or once a tool it
 * registered was called: tool rows carry the registering extension's file as
 * their path, which is the same path the extension row opens.
 */
function isExtensionUsed(path: string): boolean {
  if (usedExtensions.has(path)) return true;
  const tools = lastSections.find((section) => section.name === TOOLS_SECTION)?.items ?? [];
  return tools.some((tool) => tool.path === path && usedTools.has(tool.label));
}

/** Why this row is highlighted, in the words of its own section. */
function usedTitle(sectionName: string, label: string): string {
  if (sectionName === CONTEXT_SECTION) return t.contextUsedTitle;
  if (sectionName === SKILLS_SECTION) return t.skillActiveTitle(label);
  if (sectionName === PROMPTS_SECTION) return t.promptUsedTitle;
  if (sectionName === EXTENSIONS_SECTION) return t.extensionUsedTitle;
  return t.toolUsedTitle;
}

function resourceRow(item: ResourceItem, sectionName: string): HTMLElement {
  // Rows that carry a file open in the editor; error rows and built-in tools
  // stay plain text.
  const used = isUsed(sectionName, item);
  const text = item.detail ?? item.label;
  const modifiers = [used ? "resource-used" : "", item.inactive ? "resource-inactive" : ""].filter(Boolean);
  // Tooltip: what it is, then how it stands in this session, then what a click
  // would do.
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
