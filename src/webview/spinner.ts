import { el } from "./dom.js";

/**
 * The braille "working" spinner, using the same frames as the pi CLI.
 *
 * A single interval drives every spinner on the page (the working row and the
 * sessions-list badges), so they stay in phase and only one timer exists.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL_MS = 80;
const SPINNER_CLASS = "working-spinner";

let index = 0;
let timer: number | undefined;

/**
 * A spinner element showing the current frame; joins the shared animation.
 * The timer is self-managing: creating a spinner starts it, and it stops on
 * the first tick that finds no spinner left in the document.
 */
export function spinner(): HTMLSpanElement {
  const element = el("span", SPINNER_CLASS, FRAMES[index]!);
  timer ??= window.setInterval(tick, FRAME_INTERVAL_MS);
  return element;
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
