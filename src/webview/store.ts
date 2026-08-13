import type { ChatState } from "../shared/protocol.js";

/**
 * The last state snapshot pushed by the host.
 *
 * Host messages are complete snapshots, so the state is replaced rather than
 * merged: that is what clears optional fields such as a finished delegation.
 * Exported as a live binding — modules read `state.*` directly and only
 * `setState()` writes.
 */
export let state: ChatState = { ready: false, isStreaming: false, isCompacting: false };

export function setState(next: ChatState): void {
  state = next;
}

/**
 * Whether subagents are running right now.
 *
 * `state.delegation` outlives the run — the lane card keeps its final tally and
 * a lane the user opened stays readable — so its mere presence must never be
 * read as "busy". Everything that gates on activity asks this instead.
 */
export function isDelegating(): boolean {
  return Boolean(state.delegation?.running);
}

/** Whether the displayed transcript is a subagent's (running or finished). */
export function isInLane(): boolean {
  return state.delegation?.role === "child";
}

/** The lane currently on screen, if any. */
export function currentLane() {
  const delegation = state.delegation;
  if (delegation?.role !== "child") return undefined;
  return delegation.lanes.find((lane) => lane.id === delegation.currentLaneId);
}
