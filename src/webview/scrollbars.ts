/**
 * 覆盖式滚动条的滚动驱动显隐。滑块只在容器滚动期间绘制、静置后淡出：
 * 滚动条回答「我在这东西的哪里」，只在内容真的在动时才是问题。CSS 没有
 * 「正在滚动」状态，只能靠脚本；旧做法用容器 `:hover` 近似，两个方向都
 * 错——读字时停在 transcript 上会亮起一条没新东西的杠，指针离开后滚轮
 * 滚过则什么都不显示。
 * 用 document 级捕获监听而非每个容器一个：`scroll` 不冒泡但会捕获，一个
 * 监听器覆盖视图内所有滚动容器（含后来创建的），也免去曾经手工维护的滚
 * 动容器选择器清单——那份清单漂移过，横向滚动的代码块滑块曾因此永久
 * 不可见。
 */

/** 最后一次滚动事件后滑块保留多久。 */
const IDLE_MS = 900;

const CLASS = "pi-scrolling";

/** 每个元素的待执行淡出；用 WeakMap，脱离文档的节点可被回收。 */
const timers = new WeakMap<Element, number>();

export function initScrollbars(root: Document = document): () => void {
  const onScroll = (event: Event): void => {
    const target = event.target;
    // 页面自身滚动时 target 是 `document`，没有 class list；本视图从不
    // 整页滚动，也没有可显示的。
    if (!(target instanceof Element)) return;

    target.classList.add(CLASS);

    const pending = timers.get(target);
    if (pending !== undefined) clearTimeout(pending);
    timers.set(
      target,
      setTimeout(() => {
        timers.delete(target);
        target.classList.remove(CLASS);
      }, IDLE_MS) as unknown as number,
    );
  };

  // passive：这里从不 `preventDefault`，声明出来可免占它所响应滚动的
  // 关键路径。
  root.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => root.removeEventListener("scroll", onScroll, { capture: true });
}
