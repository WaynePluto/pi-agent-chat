import type { ChatEvent } from "../../shared/protocol.js";
import { inputEl } from "../shell.js";
import { closeAutocomplete } from "./autocomplete.js";
import { renderFileRefs } from "./chips.js";
import { cs, type InputHistoryEntry } from "./state.js";

/** 环容量；按 shell 的量级，满了丢最旧的。 */
const INPUT_HISTORY_LIMIT = 100;

/**
 * 已喂入输入历史的 transcript，按 id 记录。live transcript 在窗口启动时
 * 会 post 两次（attach 与 `ready`），lane / preview 往返也各重放一次；没有
 * 这份记忆，每次重放都会再堆一份相同消息——连续去重只挡相邻重复，副本
 * 会交错留下。重载后的 webview 从空集、空历史开始，再 populate 一次，
 * 这正是 `ready` 重新打标记的用途。
 */
const populatedTranscripts = new Set<string>();
const POPULATED_TRANSCRIPT_LIMIT = 16;

/**
 * 把重放 transcript 的用户消息喂进 ↑/↓ 历史，对齐 CLI 初始渲染的做法
 * （`populateHistory: true`）。只对宿主标了 `populateInputHistory` 的重放
 * 调用——即会话成为 live——因此 lane 任务（由父代理写）不会进这里。
 *
 * 文本是会话文件里的形态：模板已展开、`/skill:` 调用已折回命令形式。
 * 原始按键只在本窗口发出的 prompt 上存在（发送路径自己记），两个来源
 * 共用一个环，与 CLI 一致。
 */
export function populateInputHistoryFromEvents(transcriptId: string | undefined, events: ChatEvent[]): void {
  const key = transcriptId ?? "";
  if (populatedTranscripts.has(key)) return;
  populatedTranscripts.delete(key);
  populatedTranscripts.add(key);
  for (const oldest of populatedTranscripts) {
    if (populatedTranscripts.size <= POPULATED_TRANSCRIPT_LIMIT) break;
    populatedTranscripts.delete(oldest);
  }
  for (const event of events) {
    if (event.kind !== "user_message") continue;
    pushInputHistory({ text: event.text, references: [] });
  }
}

/**
 * 记录一条已发送的 prompt 并结束导航。连续重复不入栈（bash 的
 * `ignoredups`）：重发同一行不该让环里堆满自己的副本。
 */
export function pushInputHistory(entry: InputHistoryEntry): void {
  const last = cs.inputHistory[cs.inputHistory.length - 1];
  if (!last || last.text !== entry.text || !sameReferences(last.references, entry.references)) {
    cs.inputHistory.push(entry);
    if (cs.inputHistory.length > INPUT_HISTORY_LIMIT) cs.inputHistory.shift();
  }
  cs.historyIndex = undefined;
  cs.draft = { text: "", references: [] };
}

function sameReferences(a: InputHistoryEntry["references"], b: InputHistoryEntry["references"]): boolean {
  return a.length === b.length
    && a.every((item, index) => item.path === b[index]?.path && item.kind === b[index]?.kind);
}

/**
 * ↑/↓ 遍历历史。离开某个位置前先把 composer 写回该槽位，对召回 prompt
 * 的修改因此能活过往返——readline 同此。清空的 composer 不写回：清掉
 * 召回行读作「放弃」，回头再见原文更友好。
 */
export function navigateInputHistory(direction: -1 | 1): void {
  if (cs.historyIndex === undefined) {
    if (direction >= 0 || cs.inputHistory.length === 0) return;
    cs.draft = composerEntry();
    cs.historyIndex = cs.inputHistory.length - 1;
    fillComposer(cs.inputHistory[cs.historyIndex]!);
    return;
  }
  const current = composerEntry();
  if (current.text.trim() || current.references.length > 0) cs.inputHistory[cs.historyIndex] = current;
  const next = cs.historyIndex + direction;
  if (next < 0) return; // 已是最旧条目：停住，不环绕。
  if (next >= cs.inputHistory.length) {
    // 越过最新条目：回到 live 草稿，暂存内容恢复。
    cs.historyIndex = undefined;
    fillComposer(cs.draft);
    return;
  }
  cs.historyIndex = next;
  fillComposer(cs.inputHistory[next]!);
}

/** 把 composer 当前内容拍成一条历史条目。 */
function composerEntry(): InputHistoryEntry {
  return { text: inputEl.value, references: cs.fileRefs.map((item) => ({ ...item })) };
}

/** 用一条历史条目替换 composer 内容；光标落在末尾。 */
function fillComposer(entry: InputHistoryEntry): void {
  inputEl.value = entry.text;
  cs.fileRefs.length = 0;
  cs.fileRefs.push(...entry.references.map((item) => ({ ...item })));
  renderFileRefs();
  closeAutocomplete();
  inputEl.setSelectionRange(entry.text.length, entry.text.length);
}
