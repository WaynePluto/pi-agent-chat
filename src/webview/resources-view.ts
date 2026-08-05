import type { ResourceItem, ResourceScope, ResourceSection } from "../shared/protocol.js";
import { RESOURCES_CLASSES, RESOURCE_SECTION_CLASSES, createCollapsible } from "./collapsible.js";
import { button, el } from "./dom.js";
import { post } from "./host.js";
import { getDict } from "./i18n.js";
import { resourcesEl } from "./shell.js";

/**
 * CLI-style startup listing ([Context] / [Skills] / ...), pinned above the
 * transcript as one bordered, fully collapsible panel. Default state is
 * collapsed: only a slim one-line header is visible. Expanding shows the
 * sections; each section can further expand to full file paths.
 *
 * Skills the transcript saw being loaded are marked active here, so the panel
 * answers "did any skill actually kick in?" without scanning the work blocks.
 */

const t = getDict();

/** Section whose items are skill names, matched by the host-side listing. */
const SKILLS_SECTION = "Skills";

/**
 * Display order of the scope groups inside a section: the resources shared
 * across projects first, then the ones this workspace brings in. Rows carry no
 * scope tag of their own; the group heading answers "where is this from?".
 */
const SCOPE_ORDER: readonly ResourceScope[] = ["global", "project", "package", "other"];

let resourcesExpanded = false;
let lastSections: ResourceSection[] = [];
/** Skills loaded in the displayed transcript; reset on session/transcript swap. */
const activeSkills = new Set<string>();

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
    const skills = section.name === SKILLS_SECTION;
    const block = createCollapsible({
      classes: RESOURCE_SECTION_CLASSES,
      rootClass: "resource-section",
      label: `[${section.name}]`,
      status: section.items.map((item) => item.label).join(", "),
      parent: panel.body,
    });
    // Loaded skills are coloured rather than prefixed, so the summary line
    // keeps reading as a plain comma-separated list.
    if (skills) block.statusEl.replaceChildren(...summaryNodes(section));
    for (const scope of SCOPE_ORDER) {
      const rows = section.items.filter((item) => item.scope === scope);
      if (rows.length === 0) continue;
      block.body.appendChild(el("div", "resource-scope", t.resourceScopes[scope]));
      for (const item of rows) block.body.appendChild(resourceRow(item, skills && isActive(item) ? item.label : undefined));
    }
  }
}

function summaryNodes(section: ResourceSection): Node[] {
  const nodes: Node[] = [];
  section.items.forEach((item, index) => {
    if (index > 0) nodes.push(document.createTextNode(", "));
    nodes.push(isActive(item) ? el("span", "skill-active", item.label) : document.createTextNode(item.label));
  });
  return nodes;
}

/** Record that a skill was loaded in the current transcript. */
export function markSkillActive(name: string): void {
  if (activeSkills.has(name)) return;
  activeSkills.add(name);
  if (lastSections.some((section) => section.name === SKILLS_SECTION)) renderResources(lastSections);
}

/** Drop the active marks when another transcript is displayed. */
export function clearActiveSkills(): void {
  if (activeSkills.size === 0) return;
  activeSkills.clear();
  if (lastSections.length > 0) renderResources(lastSections);
}

/** True when there is something worth showing; drives the panel's visibility. */
export function hasResources(): boolean {
  return resourcesEl.hasChildNodes();
}

function isActive(item: ResourceItem): boolean {
  return activeSkills.has(item.label);
}

function resourceRow(item: ResourceItem, activeSkill?: string): HTMLElement {
  // Rows that carry a file open in the editor; error rows stay plain text.
  const text = item.detail ?? item.label;
  if (!item.path) return el("div", undefined, text);
  const target = item.path;
  const row = button(activeSkill ? "resource-file active" : "resource-file", text, () => post({ type: "openFile", path: target }));
  row.title = activeSkill ? `${target}\n${t.skillActiveTitle(activeSkill)}` : `${target}\n${t.resourceOpenTitle}`;
  return row;
}
