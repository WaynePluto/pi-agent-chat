import type { Collapsible } from "../collapsible.js";
import { messagesEl } from "../shell.js";
import { st } from "./state.js";

/* ---------------------------------------------------------------- */
/* 搜索支持：展开，与未渲染 body 的文本                              */
/* ---------------------------------------------------------------- */

/** 注册可折叠物的自展开方式；reveal 时返回其 body。 */
export function registerReveal(collapsible: Collapsible): void {
  st.revealActions.set(collapsible.root, () => {
    collapsible.setExpanded(true);
    return collapsible.body;
  });
}

/**
 * 展开 transcript 根与 `target` 之间的全部层级（`target` 自身是可折叠物
 * 时也含它），从最外层开始，埋在折叠执行过程里的命中得以逐层揭开：
 * 先执行过程块、再卡片、再下一次导航时卡内的 details 块（它的区域要等
 * 卡片 body 渲染后才存在）。`target` 自身成为可折叠体时返回其 body，
 * 否则 undefined。
 */
export function revealTranscriptElement(target: Element): HTMLElement | undefined {
  const chain: Array<() => HTMLElement | undefined> = [];
  for (let node: Element | null = target; node && node !== messagesEl; node = node.parentElement) {
    const action = st.revealActions.get(node as HTMLElement);
    if (action) chain.push(action);
  }
  let body: HTMLElement | undefined;
  // 从最外层开始：展开父级才会渲染子级所在的 DOM。
  for (const action of chain.reverse()) body = action() ?? body;
  return body;
}

export function registerHiddenBody(collapsible: Collapsible, getText: () => string): void {
  registerReveal(collapsible);
  st.hiddenBodies.set(collapsible.root, { body: collapsible.body, getText });
}

/** 尚未渲染的卡片 body 的可搜索文本，附卡片根元素供 reveal。 */
export function collectHiddenBodies(): Array<{ root: HTMLElement; text: string }> {
  const regions: Array<{ root: HTMLElement; text: string }> = [];
  for (const [root, region] of st.hiddenBodies) {
    if (!root.isConnected) {
      st.hiddenBodies.delete(root);
      continue;
    }
    // 已渲染：从此 DOM 语料已覆盖该文本。
    if (region.body.childElementCount > 0) continue;
    const text = region.getText();
    if (text) regions.push({ root, text });
  }
  return regions;
}
