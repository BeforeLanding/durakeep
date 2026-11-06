import type { Clock } from "@durakeep/core";

/** 尾部节流：窗口内多次 push 只保留最新值；窗口结束时发送一次。首个值立即发送。 */
export function latestThrottle<T>(clock: Clock, ms: number, send: (v: T) => void) {
  let pending: { v: T } | undefined;
  let cancel: (() => void) | undefined;
  let lastSent = Number.NEGATIVE_INFINITY;
  let closed = false;
  const flush = () => {
    cancel = undefined;
    if (closed || !pending) return;
    const { v } = pending;
    pending = undefined;
    lastSent = clock.now();
    send(v);
  };
  return {
    push(v: T) {
      if (closed) return;
      pending = { v };
      if (cancel) return; // 已排定，等待发送最新值
      const wait = lastSent + ms - clock.now();
      if (wait <= 0) flush();
      else cancel = clock.setTimer(flush, wait);
    },
    close() {
      closed = true;
      cancel?.();
      cancel = undefined;
      pending = undefined;
    },
  };
}
