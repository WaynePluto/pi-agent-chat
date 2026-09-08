import { MAX_FILE_REFERENCES, type ProjectFileItem, type SlashCommand } from "../../shared/protocol.js";
import { el } from "../dom.js";
import { MAX_COMMAND_MATCHES } from "../format.js";
import { post } from "../host.js";
import { getDict } from "../i18n.js";
import { autocompleteEl, inputEl } from "../shell.js";
import { state } from "../store.js";
import { displayProjectPath, renderFileRefs } from "./chips.js";
import { cs } from "./state.js";

const t = getDict();

const FILE_QUERY_DEBOUNCE_MS = 80;

export function isAutocompleteOpen(): boolean {
  return !autocompleteEl.classList.contains("hidden");
}

/** 与 CLI 编辑器一致：仅以 `/` 开头时触发命令列表。 */
function currentCommandPrefix(): string | undefined {
  const value = inputEl.value;
  if (!value.startsWith("/")) return undefined;
  const firstSpace = value.indexOf(" ");
  if (firstSpace !== -1) return undefined;
  return value.slice(1);
}

export function updateAutocomplete(): void {
  const filePrefix = currentFilePrefix();
  if (filePrefix !== undefined) {
    cs.acMode = "file";
    scheduleFileQuery(filePrefix);
    return;
  }
  cs.acMode = "slash";
  const prefix = currentCommandPrefix();
  if (prefix === undefined) {
    closeAutocomplete();
    return;
  }
  cs.matches = filterCommands(prefix);
  if (cs.matches.length === 0) {
    closeAutocomplete();
    return;
  }
  cs.selectedIndex = 0;
  renderAutocomplete();
}

/** 前缀匹配在前、子串匹配在后；两组各自按字母序。 */
function filterCommands(prefix: string): SlashCommand[] {
  const needle = prefix.toLowerCase();
  const starts: SlashCommand[] = [];
  const contains: SlashCommand[] = [];
  for (const command of cs.slashCommands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(needle)) starts.push(command);
    else if (needle && name.includes(needle)) contains.push(command);
  }
  return [...starts, ...contains].slice(0, MAX_COMMAND_MATCHES);
}

function renderAutocomplete(): void {
  autocompleteEl.replaceChildren();
  cs.matches.forEach((command, index) => {
    const row = el("div", `autocomplete-row${index === cs.selectedIndex ? " selected" : ""}`);
    row.append(
      el("span", "autocomplete-name", `/${command.name}`),
      el("span", `autocomplete-kind ${command.kind}`, command.kind),
      el("span", "autocomplete-description", [command.argumentHint, command.description].filter(Boolean).join("  ")),
    );
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      cs.selectedIndex = index;
      acceptCompletion();
    });
    autocompleteEl.appendChild(row);
  });
  autocompleteEl.classList.remove("hidden");
}

export function moveSelection(delta: number): void {
  const total = cs.acMode === "file" ? cs.fileMatches.length : cs.matches.length;
  if (total === 0) return;
  cs.selectedIndex = (cs.selectedIndex + delta + total) % total;
  if (cs.acMode === "file") renderFileAutocomplete();
  else {
    renderAutocomplete();
    autocompleteEl.children[cs.selectedIndex]?.scrollIntoView({ block: "nearest" });
  }
}

export function acceptCompletion(): void {
  if (cs.acMode === "file") {
    acceptFileCompletion();
    return;
  }
  const command = cs.matches[cs.selectedIndex];
  if (!command) return;
  // 无参数命令可直接发送；否则等待输入。
  inputEl.value = command.argumentHint ? `/${command.name} ` : `/${command.name}`;
  closeAutocomplete();
  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
}

export function closeAutocomplete(): void {
  autocompleteEl.classList.add("hidden");
  cs.matches = [];
  cs.fileMatches = [];
  if (cs.fileQueryTimer !== undefined) {
    window.clearTimeout(cs.fileQueryTimer);
    cs.fileQueryTimer = undefined;
  }
}

/** 光标处（行首或空白之后）的 `@token` 触发文件选择器。 */
export function currentFilePrefix(): string | undefined {
  if (state.inputDisabled) return undefined;
  const caret = inputEl.selectionStart ?? inputEl.value.length;
  const before = inputEl.value.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  return match ? match[1] : undefined;
}

/** 防抖的宿主往返；过期响应按 requestId 丢弃。 */
function scheduleFileQuery(query: string): void {
  if (cs.fileQueryTimer !== undefined) window.clearTimeout(cs.fileQueryTimer);
  cs.fileQueryTimer = window.setTimeout(() => {
    cs.fileQueryTimer = undefined;
    if (currentFilePrefix() === undefined) return;
    post({ type: "listProjectFiles", requestId: ++cs.fileRequestId, query, includeIgnored: cs.fileIncludeIgnored });
  }, FILE_QUERY_DEBOUNCE_MS);
}

export function requestFileMatches(): void {
  const prefix = currentFilePrefix();
  if (prefix === undefined) return;
  post({ type: "listProjectFiles", requestId: ++cs.fileRequestId, query: prefix, includeIgnored: cs.fileIncludeIgnored });
}

export function onProjectFiles(requestId: number, items: ProjectFileItem[], error?: string): void {
  if (requestId !== cs.fileRequestId || currentFilePrefix() === undefined) return;
  const chosen = new Set(cs.fileRefs.map((item) => item.path));
  cs.fileMatches = items.filter((item) => !chosen.has(item.path));
  if (error) {
    closeAutocomplete();
    return;
  }
  // 无匹配也保持面板打开：提示行说明如何切换 gitignore 文件（Ctrl+→），
  // 缺的可能正是它。
  cs.acMode = "file";
  cs.selectedIndex = 0;
  renderFileAutocomplete();
}

function renderFileAutocomplete(): void {
  autocompleteEl.replaceChildren();
  autocompleteEl.appendChild(
    el("div", "autocomplete-hint", cs.fileIncludeIgnored ? t.fileHintIgnoredShown : t.fileHintIgnoredHidden),
  );

  cs.fileMatches.forEach((item, index) => {
    const row = el("div", `autocomplete-row${index === cs.selectedIndex ? " selected" : ""}`);
    row.appendChild(el("span", "autocomplete-name", displayProjectPath(item)));
    if (item.ignored) row.appendChild(el("span", "autocomplete-kind", t.fileIgnoredBadge));
    if (item.sensitive) row.appendChild(el("span", "autocomplete-kind sensitive", t.fileSensitiveBadge));
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      cs.selectedIndex = index;
      acceptCompletion();
    });
    autocompleteEl.appendChild(row);
  });
  autocompleteEl.classList.remove("hidden");
  autocompleteEl.children[cs.selectedIndex + 1]?.scrollIntoView({ block: "nearest" });
}

/** 删掉光标处的 `@token`，改为添加一个 chip。 */
function acceptFileCompletion(): void {
  const item = cs.fileMatches[cs.selectedIndex];
  if (!item) {
    // 空面板（只剩提示行）：直接关掉。
    closeAutocomplete();
    return;
  }
  if (cs.fileRefs.length >= MAX_FILE_REFERENCES) {
    closeAutocomplete();
    return;
  }
  const caret = inputEl.selectionStart ?? inputEl.value.length;
  const before = inputEl.value.slice(0, caret);
  const match = /(?:^|\s)@[^\s@]*$/.exec(before);
  if (match) {
    const start = match.index + (match[0].startsWith("@") ? 0 : 1);
    inputEl.value = inputEl.value.slice(0, start) + inputEl.value.slice(caret);
    inputEl.selectionStart = inputEl.selectionEnd = start;
  }
  cs.fileRefs.push(item);
  renderFileRefs();
  closeAutocomplete();
  inputEl.focus();
}
