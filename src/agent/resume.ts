import type { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Re-run the request an interrupted turn died on, without putting words in the
 * user's mouth.
 *
 * When automatic retry gives up ("retry failed: Connection error."), the turn
 * is over but the work is not: the transcript ends on a response that never
 * arrived. The only way to carry on used to be typing "continue", which leaves
 * a user message in the transcript *and* in the model context that says nothing
 * about the task. Resuming re-issues the same request instead: no new message
 * is appended, so the conversation reads exactly as if the connection had held.
 *
 * SDK-MIRROR: `core/agent-session.ts`. The SDK has no public "resume" entry
 * point, so this reproduces the two steps its own auto-retry takes between two
 * attempts (`_prepareRetry` + the `_runAgentPrompt` loop):
 *
 * 1. Drop the failed response from *agent state* (it stays in the session file,
 *    exactly as the SDK leaves it). Providers reject a transcript that ends on
 *    an empty assistant message, and `agent.continue()` refuses it outright.
 * 2. Run the agent loop through the session's own prompt path with an empty
 *    message batch, which is a continuation from the current transcript.
 *
 * Step 2 deliberately goes through `_runAgentPrompt` rather than the public
 * `session.agent.continue()`: the loop around it is what marks the session as
 * streaming, applies automatic retry and compaction to this attempt, and emits
 * `agent_settled`. Calling the agent directly would run the request but leave
 * the UI waiting for a settle event that never comes.
 *
 * Because that entry point is private, its presence is feature-detected: if a
 * future SDK renames it, `supportsResume()` returns false, the retry action is
 * never offered, and nothing else changes.
 */

/** The private prompt path described above. */
interface SessionRunner {
  _runAgentPrompt(messages: unknown[]): Promise<void>;
}

function runner(session: AgentSession): SessionRunner["_runAgentPrompt"] | undefined {
  const candidate = (session as unknown as Partial<SessionRunner>)._runAgentPrompt;
  return typeof candidate === "function" ? candidate : undefined;
}

/** Whether this host can resume a failed turn at all (SDK mechanism present). */
export function supportsResume(session: AgentSession): boolean {
  return runner(session) !== undefined;
}

/**
 * Whether the session is sitting on a failed response right now.
 *
 * Only a response the provider failed on may be dropped; a turn that ended
 * normally is not a retry candidate, and re-running it would silently discard
 * the answer the user is reading.
 */
export function isResumable(session: AgentSession): boolean {
  if (session.isStreaming || session.isCompacting) return false;
  if (!supportsResume(session)) return false;
  const messages = session.agent.state.messages;
  const last = messages[messages.length - 1];
  return last?.role === "assistant" && last.stopReason === "error";
}

/**
 * Re-issue the failed request. Resolves when the resumed run has settled;
 * returns false when the session has meanwhile moved past the failure.
 */
export async function resumeAfterError(session: AgentSession): Promise<boolean> {
  const run = runner(session);
  if (!run || !isResumable(session)) return false;
  const messages = session.agent.state.messages;
  session.agent.state.messages = messages.slice(0, -1);
  await run.call(session, []);
  return true;
}
