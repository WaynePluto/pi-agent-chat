/**
 * 宿主与 webview 共用的时间戳格式化。
 *
 * 必须保持零依赖：webview bundle 不能引入 Node 代码。
 */

/**
 * 按本机时区格式化为 `YYYY-MM-DD HH:MM`。
 *
 * 协议上的时间戳是 ISO 8601 UTC——线路格式该如此（无歧义、可排序）——但直接
 * 切片显示的是 UTC，列表里每条都像偏移了时区差。布局固定、不用
 * `toLocaleString()`：一列时间戳用 locale 决定的形状会参差，快照也会依赖宿主
 * ICU。本地化的只是值，不是格式。
 */
export function formatLocalTimestamp(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  // 字符串万一以其他形状到达时保留可读的内容。
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace("T", " ");
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}
