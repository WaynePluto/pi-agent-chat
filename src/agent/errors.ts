/**
 * Uniform error rendering for host-side logs and chat notices.
 *
 * Every call site previously inlined `error instanceof Error ? … : String(error)`;
 * keeping one implementation avoids drift in what users see when something fails.
 */

/** `Name: message` for real errors, `String(value)` for anything thrown. */
export function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Same as `describe()` but keeps the stack when one is available (crash reports). */
export function describeWithStack(error: unknown): string {
  return error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
}
