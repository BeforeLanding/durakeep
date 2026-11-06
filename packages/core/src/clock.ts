// 时钟接口：同一个实现同时注入 Harness（now / setTimer）和业务调度器；测试用 FakeClock 快进（ADR-03）。
export interface Clock {
  now(): number;
  setTimer(cb: () => void, ms: number): () => void; // 返回取消函数
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer(cb, ms) {
    const t = setTimeout(cb, ms);
    return () => clearTimeout(t);
  },
};

export class FakeClock implements Clock {
  #now: number;
  #timers = new Map<number, { at: number; cb: () => void }>();
  #seq = 0;
  constructor(start = Date.UTC(2026, 10, 6, 7, 0)) {
    this.#now = start;
  }
  now(): number {
    return this.#now;
  }
  setTimer(cb: () => void, ms: number): () => void {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + ms, cb });
    return () => void this.#timers.delete(id);
  }
  /** 快进并按时间顺序触发到期的定时器。 */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.#now = Math.max(this.#now, due[1].at);
      due[1].cb();
    }
    this.#now = target;
  }
}
