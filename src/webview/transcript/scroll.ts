import { messagesContentEl, messagesEl, scrollDownBtn } from "../shell.js";
import { state } from "../store.js";
import { flushDeferredFolds } from "./bubbles.js";
import { cancelSmoothScroll, onSmoothScrollSettled, smoothScrollActive, smoothScrollTo } from "./smooth-scroll.js";
import { st } from "./state.js";

/* ---------------------------------------------------------------- */
/* 粘性自动滚动                                                      */
/* ---------------------------------------------------------------- */

const NEAR_BOTTOM_PX = 40;

/** `node` 到 `root` 之间是否有会吃掉向上滚轮的元素（自身内容已滚下）。
 * 在会滚动的卡片 body 上滚轮读的是那个 body，不是 transcript——
 * 不算逃离。 */
function innerScrollerConsumesWheelUp(node: Element | null, root: Element): boolean {
  for (let el = node; el && el !== root; el = el.parentElement) {
    const overflowY = getComputedStyle(el).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollTop > 0) return true;
  }
  return false;
}

function isNearBottom(): boolean {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < NEAR_BOTTOM_PX;
}

/** 强制恢复跟随：发送消息、跳底按钮、全新视图。 */
export function resumeFollowing(): void {
  st.userWheeledUp = false;
  st.followBottom = true;
  flushDeferredFolds();
}

messagesEl.addEventListener(
  "wheel",
  (event) => {
    // 用户接管滚动：飞行中的平滑滚动立即让位。
    cancelSmoothScroll();
    if (event.deltaY < 0) {
      if (!innerScrollerConsumesWheelUp(event.target as Element | null, messagesEl)) st.userWheeledUp = true;
    } else if (event.deltaY > 0) {
      st.userWheeledUp = false;
    }
  },
  { passive: true },
);

messagesEl.addEventListener("scroll", () => {
  // 仅落到底部绝不恢复跟随。流式期间任何重渲染收缩（markdown 重解析
  // 合并未完结构、运行行消失、气泡折叠）都会把 scrollTop 钳到新的最大值
  // 并触发一次长得像「用户到底了」的 scroll——把它当恢复信号，贴底就在
  // 下一个流式事件复活，视图对着每次小幅上滚来回抖（大滚轮靠
  // NEAR_BOTTOM_PX 几何逃掉了，于是显得只有它有效）。恢复只来自显式
  // 意图：向下滚轮、跳底按钮、发送、End。
  const wasFollowing = st.followBottom;
  st.followBottom = !st.userWheeledUp && isNearBottom();
  // 手动滚回底部同样重新启用默认折叠规则，与跳底按钮
  // 经 resumeFollowing() 的效果一致。
  if (st.followBottom && !wasFollowing) flushDeferredFolds();
  updateScrollDownButton(false);
});

// 上面恢复规则的键盘出口：End 与跳底按钮同样表达「带我去看最新」。
// 加以防护，composer 自己的 End（光标到行尾）保持原语义。
window.addEventListener("keydown", (event) => {
  if (event.key !== "End") return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)
  ) {
    return;
  }
  resumeFollowing();
});

// 飞行结束（到达或被滚轮/贴底取消）时刷新跳底按钮：末帧可能不产生
// scroll 事件，最后的 scroll 处理停留在「飞行中」的隐藏判定里。
onSmoothScrollSettled(() => updateScrollDownButton(false));

scrollDownBtn.addEventListener("click", () => {
  resumeFollowing();
  // 空闲时平滑滚到底（固定时长补间）；流式/压缩期间内容每帧都在增长，
  // 贴底赋值会打断飞行中的动画，那时瞬时贴底反而更稳。
  if (state.isStreaming || state.isCompacting) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    smoothScrollTo(messagesEl.scrollHeight);
  }
  updateScrollDownButton(false);
  // scroll 事件异步触发；下一帧再查一次。
  requestAnimationFrame(() => updateScrollDownButton(false));
});

export function updateScrollDownButton(hasNews: boolean): void {
  // 正跟随最新消息、已在底部、或平滑下滚的飞行途中：隐藏。
  if (st.followBottom || isNearBottom() || smoothScrollActive()) {
    scrollDownBtn.style.display = "none";
    scrollDownBtn.classList.remove("news");
    return;
  }
  scrollDownBtn.style.display = "inline-flex";
  if (hasNews) scrollDownBtn.classList.add("news");
}

/** 重新贴底，例如用户发送新消息之后。 */
export function followLatest(): void {
  resumeFollowing();
  updateScrollDownButton(false);
}

export function scrollToEnd(): void {
  // 排队/转向气泡保持贴底（在运行指示行之上），直到被 agent 循环消费。
  for (const pending of st.pendingUserBubbles) {
    if (pending.element !== messagesContentEl.lastElementChild) messagesContentEl.appendChild(pending.element);
  }
  // 新内容到达时保持运行指示行贴底。
  if (st.workingEl && st.workingEl !== messagesContentEl.lastElementChild) messagesContentEl.appendChild(st.workingEl);
  // 尊重用户阅读位置：仅在跟随时自动滚动。程序赋值会取消飞行中的平滑
  // 滚动（先到先得），必须显式让位，否则补间下一帧又把位置夺回去。
  if (st.followBottom) {
    cancelSmoothScroll();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else updateScrollDownButton(true);
}
