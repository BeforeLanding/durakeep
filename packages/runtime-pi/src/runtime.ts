// RuntimePort 的最小实现（T-06）：create、submit、wait、observe、abort，外加 write / continue / usage / backup。
// 未实现的 loadEarlier 在 P1（T-12）补齐。
import {
  fault,
  RuntimeBusy,
  type AppEntry,
  type ConversationSnapshot,
  type Json,
  type ResumeCursor,
  type RunFailureReason,
  type RuntimePort,
  type UsageSummary,
} from "@durakeep/core";
import { backupInto as dbBackupInto } from "@durakeep/db";
import { ConversationBusy, ConversationTranscript, type Conversation } from "@earendil-works/pi-durable";
import { collectRunChunkIds, toAppEntry, toSnapshotLive, type PiEntryLike } from "./convert.ts";
import { context, type PiHandle } from "./start.ts";

export type PiRuntimeOptions = {
  model: { provider: string; modelId: string };
  maxTurns?: number;
};

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

/** ADR-09：输入信封里的本地时间，如 “2026-11-06 15:02 星期五 Asia/Shanghai”。 */
export function formatEnvelopeTime(now: number, tz: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(new Date(now))
      .map((p) => [p.type, p.value]),
  );
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${WEEKDAYS[wd]} ${tz}`;
}

export class PiRuntime implements RuntimePort {
  readonly #pi: PiHandle;
  readonly #opts: PiRuntimeOptions;

  constructor(pi: PiHandle, opts: PiRuntimeOptions) {
    this.#pi = pi;
    this.#opts = opts;
  }

  resume(): void {
    this.#pi.harness.resume();
  }

  /** 助手条目一旦写入就不会变，所以“同一次 run 里见过哪些片段”只算一次（有界缓存）。 */
  readonly #runIdsCache = new Map<string, Set<number>>();

  async #runChunkIds(c: Conversation, entryId: number): Promise<Set<number>> {
    const key = `${String(c.id)}:${entryId}`;
    const hit = this.#runIdsCache.get(key);
    if (hit) return hit;
    const ids = new Set<number>();
    let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
    for (;;) {
      const page = await c.entries(
        cursor === undefined ? { maxEntryId: (entryId - 1) as never, order: "descending" as const } : { order: "descending" as const },
        50,
        cursor,
        context,
      );
      if (collectRunChunkIds(page.items as unknown as PiEntryLike[], ids) || page.next === undefined) break;
      cursor = page.next;
    }
    if (this.#runIdsCache.size >= 1000) this.#runIdsCache.clear();
    this.#runIdsCache.set(key, ids);
    return ids;
  }

  /** 给带引用的助手条目填写 inRun：引用的 chunk 是否出现在同一次 run 的工具结果里。 */
  async #markInRun(c: Conversation, entries: AppEntry[]): Promise<void> {
    for (const e of entries) {
      if (e.kind !== "assistant" || !e.citations || e.citations.length === 0) continue;
      const seen = await this.#runChunkIds(c, Number(e.id));
      for (const cite of e.citations) cite.inRun = cite.chunkId !== null && seen.has(cite.chunkId);
    }
  }

  async #conv(id: string): Promise<Conversation> {
    const c = await this.#pi.harness.conversation(Number(id) as never, context);
    if (!c) throw new Error(`会话不存在：${id}`);
    return c;
  }

  async createConversation(input: { kind: "chat" | "background"; instructions?: string }) {
    const c = await this.#pi.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: this.#opts.model,
          maxTurns: input.kind === "background" ? 1 : (this.#opts.maxTurns ?? 8),
          ...(input.instructions ? { instructions: input.instructions } : {}),
        },
      },
      context,
    );
    return { piConversationId: String(c.id) };
  }

  async submitInput(
    conv: string,
    input: { text: string; requestId: string; steer: boolean; now: number; tz: string },
  ) {
    const c = await this.#conv(conv);
    const submission = await c.submit(
      {
        type: "input",
        content: `[当前时间 ${formatEnvelopeTime(input.now, input.tz)}]\n${input.text}`,
        entry: { kind: "app.user", data: { text: input.text, at: input.now, tz: input.tz } },
        requestId: input.requestId,
        whenBusy: input.steer ? "steer" : "followUp",
      },
      context,
    );
    fault("ingress.after_submit"); // Pi 已接纳；调用方尚未拿到结果（R1）
    return { submissionId: String(submission.id) };
  }

  async submitContinue(conv: string) {
    const c = await this.#conv(conv);
    try {
      const s = await c.submit({ type: "continue" }, context);
      return { submissionId: String(s.id) };
    } catch (e) {
      if (e instanceof ConversationBusy) throw new RuntimeBusy();
      throw e;
    }
  }

  async writeEvent(conv: string, entry: { kind: `app.${string}`; data: Json }, requestId: string) {
    const c = await this.#conv(conv);
    await c.submit({ type: "write", entry: { kind: entry.kind, data: entry.data as never }, requestId }, context);
  }

  async waitSubmission(id: string, _signal?: AbortSignal) {
    const s = await this.#pi.harness.submission(Number(id) as never, context);
    if (!s) throw new Error(`submission 不存在：${id}`);
    const settled = await s.wait(context);
    if (settled.status === "done") {
      // settled.answer 是助手条目的 ID，需要读出条目才有文本
      const answerId = (settled as { answer?: number }).answer;
      let answerText = "";
      if (answerId !== undefined) {
        const c = await this.#pi.harness.conversation(settled.conversationId, context);
        const page = await c?.entries({ minEntryId: answerId as never, maxEntryId: answerId as never }, 1, undefined, context);
        const msg = page?.items[0]?.model?.[0] as { content?: unknown } | undefined;
        const blocks = Array.isArray(msg?.content) ? (msg.content as { type?: string; text?: string }[]) : [];
        answerText = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      }
      return { status: "done" as const, answerText };
    }
    const u = settled as { reason?: string; detail?: unknown };
    return {
      status: "unanswered" as const,
      reason: (u.reason ?? "faulted") as RunFailureReason | string,
      ...(typeof u.detail === "string" ? { detail: u.detail } : {}),
    };
  }

  async abort(conv: string) {
    await (await this.#conv(conv)).abort(context);
  }

  async observe(conv: string, from: ResumeCursor | undefined, listener: (snap: ConversationSnapshot) => void) {
    const c = await this.#conv(conv);
    const transcript = new ConversationTranscript((query, limit, ctx) => c.entries(query, limit, undefined, ctx));
    const watch = await c.watch(context, from !== undefined ? { from: Number(from) as never } : undefined);
    const emit = async (view: Parameters<typeof transcript.merge>[0]) => {
      const merged = transcript.merge(view);
      const entries: AppEntry[] = [];
      let hasEarlier = false;
      for (const item of merged.items) {
        if (item.kind === "earlier") hasEarlier = true;
        else if (item.kind === "entry") {
          const e = toAppEntry(item.entry as unknown as PiEntryLike);
          if (e) entries.push(e);
        }
      }
      await this.#markInRun(c, entries).catch(() => {}); // 标注失败（如 Harness 正在关闭）时保持 inRun=false，宁可标红也不放行
      const resume = transcript.resume?.from;
      listener({
        ...(resume !== undefined ? { cursor: String(resume) } : {}),
        entries,
        live: toSnapshotLive(merged.docs as Record<string, unknown>),
        hasEarlier,
      });
    };
    // 初始快照与后续快照用同一条串行链：先 start 再发初始快照，中间不留 await 间隙（否则间隙里的提交可能被漏掉），且保证顺序
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (view: Parameters<typeof transcript.merge>[0]) => (chain = chain.then(() => emit(view)));
    const initial = enqueue(watch.value);
    watch.start(async (call) => {
      if (call.kind === "value") await enqueue(call.value);
    });
    await initial;
    return {
      stop: async () => void (await watch.stop()),
      cursor: () => {
        const r = transcript.resume?.from;
        return r === undefined ? undefined : String(r);
      },
    };
  }

  async loadEarlier(conv: string, beforeEntryId: string | undefined, limit: number) {
    const c = await this.#conv(conv);
    const before = beforeEntryId === undefined ? undefined : Number(beforeEntryId);
    if (before !== undefined && !Number.isInteger(before)) throw new Error("beforeEntryId 无效");
    const out: AppEntry[] = [];
    let cursor: Awaited<ReturnType<Conversation["entries"]>>["next"];
    let hasEarlier = false;
    // 条目 ID 有空洞，且 pi.system 等不展示：逐页向前扫描，直到凑够 limit 条可展示的条目
    for (;;) {
      const page = await c.entries(
        cursor === undefined
          ? { ...(before !== undefined ? { maxEntryId: (before - 1) as never } : {}), order: "descending" as const }
          : { order: "descending" as const },
        Math.max(limit, 20),
        cursor,
        context,
      );
      for (const item of page.items) {
        const e = toAppEntry(item as unknown as PiEntryLike);
        if (!e) continue;
        if (out.length === limit) {
          hasEarlier = true; // 还有可展示的更早条目
          break;
        }
        out.push(e);
      }
      if (hasEarlier || page.next === undefined) break;
      cursor = page.next;
    }
    const entries = out.reverse();
    await this.#markInRun(c, entries);
    return { entries, hasEarlier };
  }

  async usage(): Promise<UsageSummary> {
    const u = await this.#pi.harness.usage(context);
    return { models: u.models as unknown as Record<string, Json>, tools: u.tools as unknown as Record<string, Json> };
  }

  async backupInto(path: string) {
    await dbBackupInto(this.#pi.db, path);
  }

  async close() {
    await this.#pi.close();
  }
}
