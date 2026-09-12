import { messagesEl } from "../shell.js";
import { resumeFollowing, scrollToEnd, updateScrollDownButton } from "./scroll.js";
import { emptyViewState, st } from "./state.js";

const MAX_REMEMBERED_TRANSCRIPTS = 8;

export function selectTranscript(id: string | undefined): void {
  const key = id ?? "";
  const existing = st.transcriptViews.get(key);
  if (existing) {
    // 重新插入以刷新 LRU 位置。
    st.transcriptViews.delete(key);
    st.transcriptViews.set(key, existing);
    st.currentView = existing;
    return;
  }
  st.currentView = emptyViewState();
  st.transcriptViews.set(key, st.currentView);
  for (const oldest of st.transcriptViews.keys()) {
    if (st.transcriptViews.size <= MAX_REMEMBERED_TRANSCRIPTS) break;
    st.transcriptViews.delete(oldest);
  }
}

/**
 * 在承载阅读位置的 DOM 被拆掉之前记录它。从 `clearMessages()` 调用：
 * 所有拆除路径都经过它，且在那里还能看到即将离开的 transcript。
 */
export function captureViewState(): void {
  // 几何只有在 transcript 可见时才读得出：窄屏会话页把聊天区整个
  // `display:none`（`.hidden` 类），隐藏期间 scrollTop 一律读作 0
  // （Chrome 会在重新显示时恢复偏移，但捕获不能拿 0 覆盖好数据——
  // hide 前的那次捕获见 main.ts 的 openSessions()）。判据用 `.hidden`
  // 而不是 clientHeight：jsdom 无布局、clientHeight 恒为 0，会把无头
  // 冒烟里的捕获全部跳过（那里程序化设置的 scrollTop 是可读的）。
  // 结构性状态（块展开、跟随标志）与布局无关，照常记录；不可见时内部
  // 滚动保留先前捕获的值。
  const visible = messagesEl.closest(".hidden") === null;
  if (visible) st.currentView.scrollTop = messagesEl.scrollTop;
  st.currentView.followBottom = st.followBottom;
  for (const [index, block] of st.workBlocks) {
    st.currentView.work.set(index, {
      expanded: block.expanded,
      scrollTop: visible ? block.body.scrollTop || undefined : st.currentView.work.get(index)?.scrollTop,
    });
  }
  if (visible) {
    for (const [id, card] of st.toolCards) {
      const scroller = card.body.querySelector(".tool-body");
      if (scroller instanceof HTMLElement && scroller.scrollTop > 0) st.currentView.toolScroll.set(id, scroller.scrollTop);
    }
  }
}

/** 重建的 transcript 进 DOM 后放回阅读位置。 */
export function restoreViewState(): void {
  for (const [index, block] of st.workBlocks) {
    const saved = st.currentView.work.get(index)?.scrollTop;
    if (saved !== undefined) block.body.scrollTop = saved;
  }
  for (const [id, card] of st.toolCards) restoreToolScroll(id, card.body);
  const saved = st.currentView.scrollTop;
  if (saved === undefined) {
    // 首次进入这个 transcript：照常显示最新内容。
    resumeFollowing();
    scrollToEnd();
    return;
  }
  // 全新视图：上一个 transcript 的滚轮意图不延续。
  st.userWheeledUp = false;
  st.followBottom = st.currentView.followBottom;
  messagesEl.scrollTop = saved;
  // Markdown、代码块与图片可能晚一帧才稳定，把刚写入的偏移下面的
  // 内容顶走。
  requestAnimationFrame(() => {
    if (st.currentView.scrollTop === saved) messagesEl.scrollTop = saved;
    updateScrollDownButton(false);
  });
}

/** 卡片 body 懒渲染，回放之后才展开的那个在这里恢复滚动。 */
export function restoreToolScroll(id: string, body: HTMLElement): void {
  const saved = st.currentView.toolScroll.get(id);
  if (saved === undefined) return;
  const scroller = body.querySelector(".tool-body");
  if (scroller instanceof HTMLElement) scroller.scrollTop = saved;
}
