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
