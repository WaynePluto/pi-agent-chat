/**
 * The resource listing shown in the webview's resources panel.
 *
 * Pure projection over a session's `ResourceLoader`: no VS Code API, no bridge
 * state, so the offline diagnostics can build a listing from a bare session.
 * Split out of `bridge.ts`, which was importing it only to post the result.
 */

import { basename, isAbsolute, relative as relativePath, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ResourceItem, ResourceScope, ResourceSection } from "../shared/protocol.js";
import type { ResourceActivity } from "./activity.js";

/**
 * What the listing needs from the runtime. Structural so the offline
 * diagnostics can pass a bare session instead of a full `PiRuntime`.
 */
export interface ResourceHost {
  session: AgentSession;
  cwd: string;
}

/**
 * Build the CLI-style startup listing from the session's resource loader,
 * mirroring `interactive-mode`'s [Context] / [Skills] / [Prompts] /
 * [Extensions] sections, plus a [Tools] section the CLI has no equivalent for.
 * Empty sections are omitted, and the CLI's [Themes] section is dropped
 * entirely: the webview renders with VS Code theme variables, so a pi theme
 * would be listed as loaded while having no effect here.
 *
 * Only pi's own resource kinds are listed. Directory conventions invented by a
 * single extension (`~/.pi/agent/agents/`, for one) are deliberately absent:
 * pi has no loader for them, so listing them here would present one
 * extension's private layout as a first-class concept of this host.
 *
 * `activity` marks the rows that took effect in this session (see
 * `agent/activity.ts`); the diagnostics command omits it and gets a listing
 * without any "used here" marks.
 */
export function collectResourceSections(runtime: ResourceHost, activity?: ResourceActivity): ResourceSection[] {
  const loader = runtime.session.resourceLoader;
  const sections: ResourceSection[] = [];
  // Every row can be opened in the editor, so it shows just the name (the path
  // stays in the row's tooltip); provenance drives the webview's grouping.
  const entry = (name: string, path: string, sourceInfo?: { origin?: string }) => resourceEntry(name, path, runtime.cwd, sourceInfo);

  const systemPromptSource = loader.getSystemPromptSource();
  const contextFiles = [
    ...(systemPromptSource ? [systemPromptSource] : []),
    ...loader.getAppendSystemPromptSources(),
    ...loader.getAgentsFiles().agentsFiles,
  ];
  if (contextFiles.length > 0) {
    // Context files are inlined into the system prompt on every request, so
    // they are all in effect together, from the first request onwards.
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
        // A failed extension has no loaded file to open, so it keeps the error
        // as its row text, and is dimmed: it is configured but not in effect.
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
 * Every tool the session has configured, whether or not it is active.
 *
 * pi registers seven built-in tools but only activates `read`/`bash`/`edit`/
 * `write` (`core/sdk.ts`), so `grep`/`find`/`ls` show up here as inactive until
 * an extension turns them on — which is exactly the question this row answers.
 * Built-in and SDK-provided tools carry a synthetic `<builtin:read>` path and
 * open nothing; tools registered by an extension keep that extension's file,
 * so the row leads to whoever provides them.
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
 * Build one listing section, sorted by label. Rows carry their scope so the
 * webview can group them (global first, then project) instead of tagging every
 * row with its origin.
 */
function sortedSection(name: string, items: ResourceItem[]): ResourceSection {
  return { name, items: [...items].sort((a, b) => a.label.localeCompare(b.label)) };
}

/**
 * One listing row: the resource name as the text, the file behind it as the
 * click/tooltip target.
 */
function resourceEntry(name: string, path: string, cwd: string, sourceInfo?: { origin?: string }): ResourceItem {
  if (!path) return { label: name, scope: "other" };
  return { label: name, path, scope: resourceScope(path, cwd, sourceInfo) };
}

/**
 * Where a resource comes from, in the terms the SDK documents
 * (`docs/skills.md`). `sourceInfo.scope` is not usable directly: skills under
 * `~/.agents/skills` or a project `.agents/skills` are neither of the SDK's
 * "user"/"project" roots and end up as "temporary", so classify by location.
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
