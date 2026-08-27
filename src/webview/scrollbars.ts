/**
 * Scroll-driven reveal for the overlay scrollbars.
 *
 * A scrollbar answers "where am I in this", and that is only a question while
 * the content is actually moving. So the thumb is painted only while a
 * container is being scrolled, and fades back out once it goes quiet.
 *
 * This has to be script-driven because CSS has no "is scrolling" state. The
 * previous approach approximated it with `:hover` on the container, which was
 * wrong in both directions: resting the pointer over the transcript while
 * reading lit up a bar that reported nothing new, and scrolling with a wheel
 * from a position the pointer had since left showed nothing at all.
 *
 * One document-level capture listener rather than a listener per container:
 * `scroll` does not bubble, but it does capture, so this catches every scroller
 * in the view including ones created later (code blocks, tool cards, popups).
 * That also removes the need for the hand-maintained list of scroller selectors
 * this used to require -- a list that had already drifted, leaving every
 * horizontally scrolling code block with a permanently invisible thumb.
 */

/** How long the bar stays up after the last scroll event. */
const IDLE_MS = 900;

const CLASS = "pi-scrolling";

/** Pending fade-out per element; weak so detached nodes are collectable. */
const timers = new WeakMap<Element, number>();

export function initScrollbars(root: Document = document): () => void {
  const onScroll = (event: Event): void => {
    const target = event.target;
    // Scrolling the page itself reports `document`, which has no class list.
    // The view never scrolls at the document level, so there is nothing to
    // show for it either.
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

  // Passive: this never calls `preventDefault`, and saying so keeps it off the
  // critical path of the scroll it is reacting to.
  root.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => root.removeEventListener("scroll", onScroll, { capture: true });
}
