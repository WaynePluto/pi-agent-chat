import { messagesEl } from "../shell.js";

/**
 * 固定时长的平滑滚动。不依赖浏览器原生的 `behavior: "smooth"`——它的时长
 * 随距离增长，transcript 里动辄数千像素的长跳会飞上数秒；对话视图要的是
 * 快速、可预期的短动效。ease-out 曲线与 CSS 折叠动画（0.22s ease）同一
 * 节奏。用户滚轮与任何程序赋值（如流式贴底）都会取消飞行，先到先得。
 */
const DURATION_MS = 260;

let raf = 0;
/** 到达或被取消前视为「飞行中」：跳底按钮在这段时间里不闪回。 */
let flightUntil = 0;

export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function smoothScrollActive(): boolean {
  return performance.now() < flightUntil;
}

/** 飞行结束（到达或被取消）的订阅。飞行中的按钮状态等 UI 依赖 scroll
 * 事件刷新，而末帧赋值若没产生 scroll 事件（位置取整后无变化），最后一个
 * 事件停留在飞行中——没有这个通知，跳底按钮会一直藏在「飞行中」的判定里。 */
let settledListener: (() => void) | undefined;

export function onSmoothScrollSettled(listener: () => void): void {
  settledListener = listener;
}

export function cancelSmoothScroll(): void {
  const wasFlying = Boolean(raf);
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  flightUntil = 0;
  if (wasFlying) settledListener?.();
}

export function smoothScrollTo(top: number): void {
  cancelSmoothScroll();
  const from = messagesEl.scrollTop;
  const distance = top - from;
  // 无 rAF 的无头环境（jsdom 未开 pretendToBeVisual）与要求减少动效的
  // 用户一样走瞬时：两者都没有可看的动画。近到看不出移动的也一样。
  if (typeof requestAnimationFrame !== "function" || prefersReducedMotion() || Math.abs(distance) < 2) {
    messagesEl.scrollTop = top;
    return;
  }
  const t0 = performance.now();
  flightUntil = t0 + DURATION_MS + 80;
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / DURATION_MS);
    messagesEl.scrollTop = from + distance * (1 - (1 - k) ** 3);
    if (k < 1) {
      raf = requestAnimationFrame(step);
    } else {
      raf = 0;
      flightUntil = 0;
      settledListener?.();
    }
  };
  raf = requestAnimationFrame(step);
}
