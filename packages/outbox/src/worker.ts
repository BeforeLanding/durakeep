
import { fault, uuidv7, type Clock } from "@durakeep/core";
import { deliveryPaused, type SqlDatabase } from "@durakeep/db";
import type { DeliveryResult, FeishuWebhookSender, ReminderDelivery } from "./feishu.ts";

const RETRY_DELAYS = [30_000, 120_000];
const MAX_ATTEMPTS = 3;

const REVIEW_TITLE = "飞书投递待核对";
const REVIEW_BODY = "请核对飞书群是否收到提醒，再在任务页标记已送达、重新发送或放弃。";
type ReviewNotice = { id: string; kind: "system"; title: string; body: string; link: string };
type Claimed = { id: string; attempts: number; payload_json: string };
type WorkerOptions = {
  ownerId: string;
  sender?: FeishuWebhookSender;
  onReview?: (notice: ReviewNotice) => void;
  onError?: () => void;
};

export class OutboxWorker {
  readonly #db: SqlDatabase;
  readonly #clock: Clock;
  readonly #opts: WorkerOptions;
  #cancel?: () => void;
  #task?: Promise<void>;
  #stopped = true;
  #again = false;

  constructor(db: SqlDatabase, clock: Clock, opts: WorkerOptions) {
    this.#db = db;
    this.#clock = clock;
    this.#opts = opts;
  }

  start(): void {
    this.#stopped = false;
    this.wake();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#cancel?.();
    await this.#task;
  }

  wake(): void {
    if (this.#stopped || !this.#opts.sender) return;
    this.#cancel?.();
    this.#again = true;
    this.#task ??= this.#pump().catch(() => {
      this.#opts.onError?.();
      if (!this.#stopped) this.#cancel = this.#clock.setTimer(() => this.wake(), 60_000);
    }).finally(() => {
      this.#task = undefined;
      if (this.#again && !this.#stopped) this.wake();
    });
  }

  /** 恢复和发送共用一个单进程 worker。恢复扫描在开始发送前完成。 */
  async recover(): Promise<void> {
    const owner = this.#opts.ownerId;
    await this.#db.run(
      "UPDATE app_outbox SET status = 'unknown', error_code = 'send_interrupted', updated_at = ? WHERE owner_id = ? AND status = 'dispatching'",
      this.#clock.now(), owner,
    );
    const rows = await this.#db.all<{ id: string }>("SELECT id FROM app_outbox WHERE owner_id = ? AND status = 'unknown'", owner);
    for (const row of rows) await this.#review(row.id);
  }

  async #pump(): Promise<void> {
    const sender = this.#opts.sender!;
    while (this.#again && !this.#stopped) {
      this.#again = false;
      // 也处理运行中写回失败留下的 dispatching / unknown。此时没有活跃发送。
      await this.recover();
      while (!this.#stopped) {
        const row = await this.#claim();
        if (!row) break;
        let result: DeliveryResult;
        const payload = readPayload(row.payload_json);
        if (this.#stopped) {
          // 已领取，尚未发送。正常关机可安全退回队列。
          await this.#db.run(
            "UPDATE app_outbox SET status = 'pending', attempts = attempts - 1 WHERE owner_id = ? AND id = ? AND status = 'dispatching'",
            this.#opts.ownerId, row.id,
          );
          return;
        }
        if (payload) result = await sender.send(payload, this.#clock.now());
        else result = { status: "failed", code: "invalid_payload" };
        if (result.status === "succeeded") fault("outbox.after_send");
        await this.#finish(row, result);
      }
    }
    if (this.#stopped || await deliveryPaused(this.#db)) return;
    const next = await this.#db.get<{ at: number | null }>(
      "SELECT MIN(next_attempt_at) AS at FROM app_outbox WHERE owner_id = ? AND status = 'pending'", this.#opts.ownerId,
    );
    if (!this.#stopped && next?.at != null) {
      this.#cancel = this.#clock.setTimer(() => this.wake(), Math.max(0, next.at - this.#clock.now()));
    }
  }

  async #claim(): Promise<Claimed | undefined> {
    const owner = this.#opts.ownerId;
    return this.#db.transaction(async (tx) => {
      if (await deliveryPaused(tx)) return undefined;
      const now = this.#clock.now();
      const row = await tx.get<Claimed>(
        "SELECT id, attempts, payload_json FROM app_outbox WHERE owner_id = ? AND status = 'pending' AND next_attempt_at <= ? " +
        "ORDER BY next_attempt_at, id LIMIT 1",
        owner, now,
      );
      if (!row) return undefined;
      await tx.run(
        "UPDATE app_outbox SET status = 'dispatching', attempts = attempts + 1, updated_at = ? WHERE owner_id = ? AND id = ? AND status = 'pending'",
        now, owner, row.id,
      );
      return { ...row, attempts: row.attempts + 1 };
    });
  }

  async #finish(row: Claimed, result: DeliveryResult): Promise<void> {
    const now = this.#clock.now();
    const retry = result.status === "retry" && row.attempts < MAX_ATTEMPTS;
    const status = result.status === "retry" ? (retry ? "pending" : "failed") : result.status;
    await this.#db.run(
      "UPDATE app_outbox SET status = ?, next_attempt_at = ?, error_code = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND status = 'dispatching'",
      status, retry ? now + RETRY_DELAYS[row.attempts - 1]! : now,
      result.status === "succeeded" ? null : result.code, now, this.#opts.ownerId, row.id,
    );
    if (status === "unknown") await this.#review(row.id);
  }

  async #review(id: string): Promise<void> {
    const owner = this.#opts.ownerId;
    const notice = await this.#db.transaction(async (tx) => {
      const row = await tx.get<{ error_code: string | null }>(
        "SELECT error_code FROM app_outbox WHERE owner_id = ? AND id = ? AND status = 'unknown'", owner, id,
      );
      if (!row) return undefined;
      const now = this.#clock.now();
      await tx.run(
        "UPDATE app_outbox SET status = 'needs_review', updated_at = ? WHERE owner_id = ? AND id = ? AND status = 'unknown'",
        now, owner, id,
      );
      await tx.run(
        "INSERT INTO app_events (id, level, kind, ref_json, message, created_at) VALUES (?, 'warn', 'outbox.needs_review', ?, 'needs_review', ?)",
        uuidv7(now), JSON.stringify({ owner_id: owner, outbox_id: id, previous_status: "unknown", error_code: row.error_code }), now,
      );
      return tx.get<ReviewNotice>(
        "INSERT INTO app_notifications (id, owner_id, dedupe_key, kind, title, body, link, created_at) " +
        "VALUES (?, ?, ?, 'system', ?, ?, '/jobs', ?) ON CONFLICT(owner_id, dedupe_key) DO NOTHING RETURNING id, kind, title, body, link",
        uuidv7(now), owner, "outbox:review:" + id, REVIEW_TITLE, REVIEW_BODY, now,
      );
    });
    if (notice) this.#opts.onReview?.(notice);
  }
}

function readPayload(json: string): ReminderDelivery | undefined {
  try {
    const value = JSON.parse(json) as Partial<ReminderDelivery> | null;
    if (typeof value?.title === "string" && typeof value.localTime === "string" &&
        typeof value.timezone === "string" && typeof value.lateMinutes === "number") {
      return { title: value.title, localTime: value.localTime, timezone: value.timezone, lateMinutes: value.lateMinutes };
    }
  } catch {
    // 持久化载荷不可读时只记录固定错误码。
  }
  return undefined;
}
