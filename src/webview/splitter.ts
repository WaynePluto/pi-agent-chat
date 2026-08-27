import { CENTER_MIN_WIDTH, RAIL_DEFAULT_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH } from "../shared/protocol.js";
import { getPersisted, setPersisted } from "./host.js";
import { resourcesSplitterEl, rootEl, sessionsSplitterEl } from "./shell.js";

/**
 * The two draggable dividers of the wide three-column layout.
 *
 * Geometry lives in one place — here — and reaches the stylesheet through four
 * custom properties on `#root` (`--rail-sessions`, `--split-sessions` and the
 * resources pair). `src/styles/_wide.scss` only declares which track reads
 * which property; it makes no sizing decisions of its own.
 *
 * Three rules define the interaction, and they are all clamps rather than
 * modes:
 *
 * - A rail may not grow past {@link RAIL_MAX_WIDTH}. Unlike the chat column's
 *   cap this is not about readability: a rail holds single-line labels, which
 *   are bounded by truncation rather than by line length, so past the width at
 *   which nothing is clipped any more the extra pixels only pad every label.
 * - A rail dragged below {@link RAIL_MIN_WIDTH} **closes**. There is no state
 *   between "open at the minimum" and "closed", which is what makes dragging a
 *   way to close a rail rather than a way to make it useless.
 * - The chat column may not be squeezed below {@link CENTER_MIN_WIDTH}. Dragging
 *   simply stops there; it never closes anything, because the chat column is
 *   the one thing this surface exists to show.
 */

/** Width of a divider's grid track, mirrored in `_wide.scss`'s chrome budget. */
const SPLITTER_WIDTH = 12;
/** Step for the ← / → keys on a focused divider. */
const KEYBOARD_STEP = 16;

export interface RailGeometry {
  /** User-chosen width, kept while the rail is closed so reopening restores it. */
  sessions: number;
  resources: number;
}

interface RailBinding {
  readonly key: keyof RailGeometry;
  readonly splitter: HTMLElement;
  /** Which way the pointer moves to make this rail wider. */
  readonly sign: 1 | -1;
  readonly cssRail: string;
  readonly cssSplitter: string;
}

const BINDINGS: readonly RailBinding[] = [
  { key: "sessions", splitter: sessionsSplitterEl, sign: 1, cssRail: "--rail-sessions", cssSplitter: "--split-sessions" },
  { key: "resources", splitter: resourcesSplitterEl, sign: -1, cssRail: "--rail-resources", cssSplitter: "--split-resources" },
];

/**
 * Restored before the first layout for the same reason as the content width:
 * a controller swap reassigns `webview.html`, and a fresh webview that fell
 * back to the defaults would resize the user's columns behind their back.
 */
function restoreWidths(): RailGeometry {
  const saved = getPersisted<Partial<RailGeometry>>("railWidths");
  return {
    sessions: clampRail(saved?.sessions),
    resources: clampRail(saved?.resources),
  };
}

function clampRail(value: unknown): number {
  const width = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : RAIL_DEFAULT_WIDTH;
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, width));
}

const widths = restoreWidths();
let openState: Record<keyof RailGeometry, boolean> = { sessions: false, resources: false };
/** Set by `initSplitters`; lets a drag that closes a rail update the header toggle. */
let onRailClosed: (rail: keyof RailGeometry) => void = () => {};
/**
 * Width the columns have to share, fed in by the shell's ResizeObserver.
 *
 * Deliberately *not* measured from the DOM. A measurement is only meaningful
 * once the surface has been laid out at its new size, and every caller here
 * runs at a moment when that is not guaranteed — the wide/narrow flip has just
 * rewritten the grid, and a headless environment never lays out at all. A
 * measurement taken then reads 0, every rail looks impossible to fit, and both
 * would be closed as if the user had dragged them shut. The observer already
 * knows the width; taking it from there removes the failure mode instead of
 * timing around it.
 */
let availableWidth = 0;

/** Called by the shell whenever the viewport width changes. */
export function setAvailableWidth(width: number): void {
  availableWidth = Number.isFinite(width) ? Math.round(width) : 0;
}

/** Current width of a rail as the grid sees it: 0 while it is closed. */
function effectiveWidth(key: keyof RailGeometry): number {
  return openState[key] ? widths[key] : 0;
}

/**
 * Push the geometry into the stylesheet. A closed rail collapses both its own
 * track and its divider's, so no chrome is left behind where a rail used to be
 * — which is what lets the chat column take over the space.
 */
function applyGeometry(): void {
  for (const binding of BINDINGS) {
    const open = openState[binding.key];
    rootEl.style.setProperty(binding.cssRail, `${effectiveWidth(binding.key)}px`);
    rootEl.style.setProperty(binding.cssSplitter, open ? `${SPLITTER_WIDTH}px` : "0px");
    binding.splitter.classList.toggle("hidden", !open);
    binding.splitter.setAttribute("aria-valuenow", String(effectiveWidth(binding.key)));
    binding.splitter.setAttribute("aria-valuemin", String(RAIL_MIN_WIDTH));
    binding.splitter.setAttribute("aria-valuemax", String(RAIL_MAX_WIDTH));
  }
}

/**
 * How wide this rail may become before the chat column would drop below its
 * minimum. Computed against the *other* rail's current width, so the two
 * dividers constrain each other exactly as the grid does.
 */
function maxWidthFor(key: keyof RailGeometry): number {
  const other = key === "sessions" ? "resources" : "sessions";
  const chrome = 24 + (openState[other] ? SPLITTER_WIDTH : 0) + SPLITTER_WIDTH;
  const available = availableWidth - chrome - effectiveWidth(other) - CENTER_MIN_WIDTH;
  return Math.min(RAIL_MAX_WIDTH, available);
}

/**
 * Resolve a proposed width into the resulting state.
 *
 * Below the minimum the rail closes rather than shrinking further; the width
 * it had is kept so that reopening it restores the user's choice instead of
 * snapping back to the default.
 */
function resolve(key: keyof RailGeometry, proposed: number): void {
  const ceiling = maxWidthFor(key);
  if (proposed < RAIL_MIN_WIDTH) {
    if (!openState[key]) return;
    openState[key] = false;
    applyGeometry();
    onRailClosed(key);
    return;
  }
  // A viewport too narrow to honour the minimum cannot be dragged into one.
  widths[key] = Math.max(RAIL_MIN_WIDTH, Math.min(Math.round(proposed), Math.max(RAIL_MIN_WIDTH, ceiling)));
  setPersisted("railWidths", { ...widths });
  applyGeometry();
}

function beginDrag(binding: RailBinding, event: PointerEvent): void {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = widths[binding.key];
  binding.splitter.classList.add("dragging");
  rootEl.classList.add("resizing");
  binding.splitter.setPointerCapture(event.pointerId);

  const move = (moved: PointerEvent): void => {
    resolve(binding.key, startWidth + (moved.clientX - startX) * binding.sign);
  };
  const end = (): void => {
    binding.splitter.classList.remove("dragging");
    rootEl.classList.remove("resizing");
    binding.splitter.removeEventListener("pointermove", move);
    binding.splitter.removeEventListener("pointerup", end);
    binding.splitter.removeEventListener("pointercancel", end);
  };
  binding.splitter.addEventListener("pointermove", move);
  binding.splitter.addEventListener("pointerup", end);
  binding.splitter.addEventListener("pointercancel", end);
}

/**
 * Wire the dividers. `onClosed` lets the shell keep its header toggle in step
 * when a drag — rather than a click — is what closed a rail.
 */
export function initSplitters(onClosed: (rail: keyof RailGeometry) => void): void {
  onRailClosed = onClosed;
  for (const binding of BINDINGS) {
    binding.splitter.addEventListener("pointerdown", (event) => beginDrag(binding, event));
    binding.splitter.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      resolve(binding.key, widths[binding.key] + direction * binding.sign * KEYBOARD_STEP);
    });
    // Double-clicking a seam is the familiar "reset this column" gesture, and
    // what it resets to is the default width, not the floor.
    binding.splitter.addEventListener("dblclick", () => resolve(binding.key, RAIL_DEFAULT_WIDTH));
  }
  applyGeometry();
}

/** Open or close a rail from the header toggle. */
export function setRailOpen(rail: keyof RailGeometry, open: boolean): void {
  if (openState[rail] === open) return;
  openState[rail] = open;
  // Reopening into a viewport that shrank meanwhile must not push the chat
  // column below its minimum, so the stored width is re-clamped on the way in.
  if (open) {
    const ceiling = maxWidthFor(rail);
    if (ceiling >= RAIL_MIN_WIDTH) widths[rail] = Math.min(widths[rail], ceiling);
  }
  applyGeometry();
}

/**
 * Re-clamp after the webview itself changed size, so a shrinking window walks
 * the rails back instead of squeezing the chat column past its minimum. A rail
 * that can no longer meet its own minimum closes, exactly as a drag would.
 */
export function reflowRails(): void {
  // Nothing has been laid out yet: no width is known, so no rail can be judged
  // impossible. Staying put is the only safe answer — closing here would
  // silently discard the user's choice on the way into wide mode.
  if (availableWidth <= 0) return;
  for (const binding of BINDINGS) {
    if (!openState[binding.key]) continue;
    const ceiling = maxWidthFor(binding.key);
    if (ceiling < RAIL_MIN_WIDTH) {
      openState[binding.key] = false;
      applyGeometry();
      onRailClosed(binding.key);
      continue;
    }
    if (widths[binding.key] > ceiling) {
      widths[binding.key] = ceiling;
      applyGeometry();
    }
  }
}
