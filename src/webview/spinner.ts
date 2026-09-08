import { el } from "./dom.js";

/**
 * 盲文「工作中」spinner，帧序列与 pi CLI 相同。
 *
 * 单个 interval 驱动页面上所有 spinner（工作行与会话列表徽章），保持同相
 * 且只有一个定时器。
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL_MS = 80;
const SPINNER_CLASS = "working-spinner";

let index = 0;
let timer: number | undefined;

/**
 * 显示当前帧的 spinner 元素，加入共享动画。定时器自管理：创建 spinner 即
 * 启动它，某个 tick 发现文档里一个 spinner 都没有时就停止。
 */
export function spinner(): HTMLSpanElement {
  const element = el("span", SPINNER_CLASS, FRAMES[index]!);
  ensureSpinnerRunning();
  return element;
}

/**
 * 定时器已停时重新启动。
 *
 * 定时器在首个发现文档里没有 spinner 的 tick 上自尽，而创建元素是唯一能
 * 复活它的常规路径。**先脱离文档、稍后重新挂回同一个 spinner 元素**的调
 * 用方因此会落得「元素活着、定时器死了」——帧永远停在某一格。任何这类
 * 调用方都必须在这里报告重新挂回。
 */
export function ensureSpinnerRunning(): void {
  timer ??= window.setInterval(tick, FRAME_INTERVAL_MS);
}

function tick(): void {
  const elements = document.querySelectorAll(`.${SPINNER_CLASS}`);
  if (elements.length === 0) {
    window.clearInterval(timer);
    timer = undefined;
    return;
  }
  index = (index + 1) % FRAMES.length;
  for (const element of elements) {
    element.textContent = FRAMES[index]!;
  }
}
