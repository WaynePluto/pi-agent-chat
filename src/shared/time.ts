/**
 * Timestamp formatting shared by the host and the webview.
 *
 * Must stay dependency-free: the webview bundle cannot pull in Node code.
 */

/**
 * `YYYY-MM-DD HH:MM` in the machine's own time zone.
 *
 * Timestamps travel over the protocol as ISO 8601 UTC (`...Z`), which is the
 * right wire format — unambiguous and sortable — but it is not what a person
 * reading a session list wants to see: slicing the string straight out of the
 * ISO form shows UTC, so every entry looks shifted by the local offset.
 *
 * The layout is fixed rather than `toLocaleString()`: the list is a column of
 * timestamps, and a locale-dependent shape would make it ragged and would make
 * the webview snapshot depend on the host's ICU locale. Only the *value* is
 * localized, not the format.
 */
export function formatLocalTimestamp(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  // Keep something readable if the string ever arrives in another shape.
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace("T", " ");
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
