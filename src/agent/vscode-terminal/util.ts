import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS } from "./constants.js";

export function clampTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, Math.round(value)));
}

export function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 可取消的延迟，命令结束后不留定时器。 */
export function timer(ms: number): { promise: Promise<void>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => (handle === undefined ? undefined : clearTimeout(handle)) };
}

export function abortSignalPromise(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return new Promise<void>(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
