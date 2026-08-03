import type { ResourceSection } from "../shared/protocol.js";
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
 */

const t = getDict();

let resourcesExpanded = false;

export function renderResources(sections: ResourceSection[]): void {
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
      status: section.items.join(", "),
      parent: panel.body,
    });
    for (const path of section.details) block.body.appendChild(resourceRow(path));
  }
}

/** True when there is something worth showing; drives the panel's visibility. */
export function hasResources(): boolean {
  return resourcesEl.hasChildNodes();
}

function resourceRow(path: string): HTMLElement {
  // Rows that are plain paths open in the editor; error rows ("path: msg") stay text.
  if (path.includes(": ")) return el("div", undefined, path);
  const row = button("resource-file", path, () => post({ type: "openFile", path }));
  row.title = t.resourceOpenTitle;
  return row;
}
