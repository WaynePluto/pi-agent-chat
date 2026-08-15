/**
 * Uniform error rendering for host-side logs and chat notices.
 *
 * Every call site previously inlined `error instanceof Error ? … : String(error)`;
 * keeping one implementation avoids drift in what users see when something fails.
 */

/** `Name: message` for real errors, `String(value)` for anything thrown. */
export function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [`${error.name}: ${error.message}`];
  // Unwrap the `cause` chain: undici reports every network failure as
  // "TypeError: fetch failed" and hides the diagnostic (DNS, TLS, proxy,
  // unreachable socket) inside `cause`. Other stdlib errors nest the same way.
  let cause: unknown = error.cause;
  let guard = 0;
  while (cause instanceof Error && cause.message && guard++ < 5) {
    parts.push(cause.message);
    cause = cause.cause;
  }
  return parts.join(" — ");
}

/** Same as `describe()` but keeps the stack when one is available (crash reports). */
export function describeWithStack(error: unknown): string {
  return error instanceof Error ? (error.stack ?? describe(error)) : String(error);
}
