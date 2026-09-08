/**
 * 宿主侧日志与聊天提示共用的统一错误渲染。
 *
 * 此前每个调用点都内联 `error instanceof Error ? … : String(error)`，
 * 收敛到一处，避免各处给用户看的失败信息逐渐漂移。
 */

/** 真正的 Error 渲染为 `Name: message`，其余抛出值用 `String(value)`。 */
export function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [`${error.name}: ${error.message}`];
  // 解开 `cause` 链：undici 把一切网络失败报成 "TypeError: fetch failed"，
  // 真正的诊断（DNS/TLS/代理/不可达 socket）藏在 `cause` 里；其他标准库错误同样嵌套。
  let cause: unknown = error.cause;
  let guard = 0;
  while (cause instanceof Error && cause.message && guard++ < 5) {
    parts.push(cause.message);
    cause = cause.cause;
  }
  return parts.join(" — ");
}

/** 同 `describe()`，但有 stack 时保留 stack（崩溃报告用）。 */
export function describeWithStack(error: unknown): string {
  return error instanceof Error ? (error.stack ?? describe(error)) : String(error);
}
