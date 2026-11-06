// 进程内事件中心：全局流（06 §9.2）的来源。事件带 ownerId，只投递给对应 owner 的连接。
export type HubEvent = { ownerId: string | "*"; event: "notification" | "job" | "runtime" | "unread"; data: unknown };

export class EventHub {
  readonly #subs = new Set<(e: HubEvent) => void>();
  subscribe(fn: (e: HubEvent) => void): () => void {
    this.#subs.add(fn);
    return () => void this.#subs.delete(fn);
  }
  publish(e: HubEvent): void {
    for (const fn of [...this.#subs]) {
      try {
        fn(e);
      } catch {
        /* 单个订阅者出错不影响其他人 */
      }
    }
  }
  get size(): number {
    return this.#subs.size;
  }
}
