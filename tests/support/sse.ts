// 读取 SSE 响应的测试工具：把字节流切成 { event, id, data } 与注释行。
export type SseEvent = { event?: string; id?: string; data?: string; comment?: string; at: number };

export class SseReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buf = "";
  readonly events: SseEvent[] = [];
  constructor(res: Response) {
    if (!res.body) throw new Error("响应没有 body");
    this.#reader = res.body.getReader();
  }

  /** 读下一个事件（含注释块）；超时抛错，流结束返回 undefined。 */
  async next(timeoutMs = 5000): Promise<SseEvent | undefined> {
    for (;;) {
      const i = this.#buf.indexOf("\n\n");
      if (i >= 0) {
        const block = this.#buf.slice(0, i);
        this.#buf = this.#buf.slice(i + 2);
        const ev: SseEvent = { at: Date.now() };
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) ev.comment = line.slice(1).trim();
          else if (line.startsWith("event:")) ev.event = line.slice(6).trim();
          else if (line.startsWith("id:")) ev.id = line.slice(3).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length) ev.data = data.join("\n");
        this.events.push(ev);
        return ev;
      }
      const timer = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs));
      const chunk = await Promise.race([this.#reader.read(), timer]);
      if (chunk === "timeout") throw new Error(`SSE 等待超时（${timeoutMs}ms），已收到：${JSON.stringify(this.events.map((e) => e.event ?? e.comment))}`);
      if (chunk.done) return undefined;
      this.#buf += this.#decoder.decode(chunk.value, { stream: true });
    }
  }

  /** 只返回带 event 的事件（跳过 keep-alive 注释）。 */
  async nextEvent(timeoutMs = 5000): Promise<SseEvent> {
    for (;;) {
      const e = await this.next(timeoutMs);
      if (!e) throw new Error("流已结束");
      if (e.event) return e;
    }
  }

  /** 持续读取直到谓词成立，返回途中所有事件（含满足谓词的那一个）。 */
  async until(pred: (e: SseEvent) => boolean, timeoutMs = 8000): Promise<SseEvent[]> {
    const got: SseEvent[] = [];
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`until 超时；已收到 ${got.length} 个事件`);
      const e = await this.next(left);
      if (!e) throw new Error("流在条件满足前结束");
      got.push(e);
      if (pred(e)) return got;
    }
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel().catch(() => {});
  }
}

export type SnapshotJson = {
  entries: { id: string; type: string; text?: string }[];
  live: { running: boolean; partialText?: string; queued: number; tools: unknown[]; runFailure?: { reason: string; message: string } };
  hasEarlier: boolean;
};
export const snap = (e: SseEvent) => JSON.parse(e.data!) as SnapshotJson;
