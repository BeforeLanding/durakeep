import type { Clock } from "@durakeep/core";

/** 固定窗口限流，内存计数（06 §1）。 */
export class RateLimiter {
  readonly #clock: Clock;
  readonly #windowMs: number;
  readonly #hits = new Map<string, { start: number; count: number }>();
  constructor(clock: Clock, windowMs = 60_000) {
    this.#clock = clock;
    this.#windowMs = windowMs;
  }
  /** 返回 undefined 表示放行；否则返回需要等待的毫秒数。 */
  hit(key: string, limit: number): number | undefined {
    const now = this.#clock.now();
    const cur = this.#hits.get(key);
    if (!cur || now - cur.start >= this.#windowMs) {
      this.#hits.set(key, { start: now, count: 1 });
      return undefined;
    }
    if (cur.count >= limit) return cur.start + this.#windowMs - now;
    cur.count++;
    return undefined;
  }
}
