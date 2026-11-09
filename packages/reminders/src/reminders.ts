// 提醒（FR-REM-01…04，04 §4.3）：创建 / 修改 / 取消 / 列表，Scheduler，站内通知。
// 到期由业务库里的 Scheduler 驱动（不是每条提醒一个 sleepUntil 任务）；同一个提醒在线时只通知一次（occurrence 唯一 + 通知 dedupe_key）。
import { AppError, uuidv7, type Clock } from "@durakeep/core";
import type { SqlDatabase, SqlExecutor } from "@durakeep/db";
import { assertTimezone, describeLocal, localToUtc } from "./time.ts";

export type ScheduleStatus = "active" | "fired" | "cancelled";
export type ScheduleRow = {
  id: string;
  text: string;
  documentId: string | null;
  localDatetime: string;
  timezone: string;
  nextFireAt: number | null;
  revision: number;
  status: ScheduleStatus;
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
};
export type Occurrence = { id: string; revision: number; fireAt: number; firedAt: number; lateMs: number };
export type NotificationRow = { id: string; kind: string; title: string; body: string; link: string | null; createdAt: number; readAt: number | null };

type Raw = {
  id: string; text: string; document_id: string | null; local_datetime: string; timezone: string; next_fire_at: number | null;
  revision: number; status: ScheduleStatus; conversation_id: string | null; created_at: number; updated_at: number;
};
const COLS = "id, text, document_id, local_datetime, timezone, next_fire_at, revision, status, conversation_id, created_at, updated_at";
const map = (r: Raw): ScheduleRow => ({
  id: r.id, text: r.text, documentId: r.document_id, localDatetime: r.local_datetime, timezone: r.timezone, nextFireAt: r.next_fire_at,
  revision: r.revision, status: r.status, conversationId: r.conversation_id, createdAt: r.created_at, updatedAt: r.updated_at,
});

const MAX_TEXT = 200;
/** 比计划时间晚超过这个值触发的，当作“离线补发”（FR-REM-04）并标记迟到；统计时与正常触发分开。 */
export const CATCHUP_THRESHOLD_MS = 120_000;
/** Scheduler 最长多久自行检查一次（03 §5）。 */
export const MAX_SLEEP_MS = 60_000;

function cleanText(t: unknown): string {
  if (typeof t !== "string") throw new AppError("invalid_request", "text 必须是字符串", { issues: [{ path: "text" }] });
  const v = t.normalize("NFC").replace(/\s+/g, " ").trim();
  if (v === "" || [...v].length > MAX_TEXT) throw new AppError("invalid_request", `提醒内容需为 1–${MAX_TEXT} 个字符`, { issues: [{ path: "text" }] });
  return v;
}

export type ReminderEcho = { id: string; text: string; local: string; timezone: string; utc: string; next_fire_at: number | null; revision: number; status: ScheduleStatus };

export class ReminderService {
  readonly #db: SqlDatabase;
  readonly #clock: Clock;
  /** 创建 / 修改 / 取消之后调用，让 Scheduler 重新计算下一次唤醒。 */
  onChange: () => void = () => {};
  constructor(db: SqlDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  echo(r: ScheduleRow): ReminderEcho {
    return {
      id: r.id,
      text: r.text,
      local: describeLocal(r.nextFireAt ?? localToUtcSafe(r.localDatetime, r.timezone), r.timezone),
      timezone: r.timezone,
      utc: new Date(r.nextFireAt ?? localToUtcSafe(r.localDatetime, r.timezone)).toISOString(),
      next_fire_at: r.nextFireAt,
      revision: r.revision,
      status: r.status,
    };
  }

  async createTx(tx: SqlExecutor, ownerId: string, input: { text: unknown; local_datetime: unknown; timezone: unknown; document_id?: unknown; conversationId?: string }): Promise<ScheduleRow> {
    const text = cleanText(input.text);
    assertTimezone(input.timezone);
    const fire = localToUtc(input.local_datetime, input.timezone);
    const now = this.#clock.now();
    if (fire <= now) throw new AppError("time_in_past", `这个时间已经过去了：${describeLocal(fire, input.timezone)}（${input.timezone}），请给一个未来的时间`);
    let documentId: string | null = null;
    if (input.document_id !== undefined && input.document_id !== null) {
      if (typeof input.document_id !== "string") throw new AppError("invalid_request", "document_id 必须是字符串", { issues: [{ path: "document_id" }] });
      const d = await tx.get("SELECT 1 AS x FROM app_documents WHERE owner_id = ? AND id = ?", ownerId, input.document_id);
      if (!d) throw new AppError("not_found", "关联的资料不存在");
      documentId = input.document_id;
    }
    const id = uuidv7(now);
    await tx.run(
      `INSERT INTO app_schedules (id, owner_id, conversation_id, text, document_id, local_datetime, timezone, next_fire_at, revision, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`,
      id, ownerId, input.conversationId ?? null, text, documentId, input.local_datetime as string, input.timezone, fire, now, now,
    );
    return this.get(ownerId, id, tx);
  }
  async create(ownerId: string, input: Parameters<ReminderService["createTx"]>[2]): Promise<ScheduleRow> {
    const r = await this.#db.transaction((tx) => this.createTx(tx, ownerId, input));
    this.onChange();
    return r;
  }

  async get(ownerId: string, id: string, db: SqlExecutor = this.#db): Promise<ScheduleRow> {
    const r = await db.get<Raw>(`SELECT ${COLS} FROM app_schedules WHERE owner_id = ? AND id = ?`, ownerId, id);
    if (!r) throw new AppError("not_found", "提醒不存在");
    return map(r);
  }

  async list(ownerId: string, opts: { status?: string } = {}): Promise<(ScheduleRow & { lastOccurrence: Occurrence | null })[]> {
    if (opts.status !== undefined && !["active", "fired", "cancelled"].includes(opts.status)) throw new AppError("invalid_request", "status 无效", { issues: [{ path: "status" }] });
    const rows = await this.#db.all<Raw>(
      `SELECT ${COLS} FROM app_schedules WHERE owner_id = ? ${opts.status ? "AND status = ?" : ""} ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, COALESCE(next_fire_at, updated_at) ASC, id ASC LIMIT 200`,
      ...(opts.status ? [ownerId, opts.status] : [ownerId]),
    );
    const out = [];
    for (const r of rows) out.push({ ...map(r), lastOccurrence: await this.#lastOccurrence(r.id) });
    return out;
  }
  async #lastOccurrence(scheduleId: string): Promise<Occurrence | null> {
    const o = await this.#db.get<{ id: string; revision: number; fire_at: number; fired_at: number; late_ms: number }>(
      "SELECT id, revision, fire_at, fired_at, late_ms FROM app_occurrences WHERE schedule_id = ? ORDER BY fired_at DESC, id DESC LIMIT 1",
      scheduleId,
    );
    return o ? { id: o.id, revision: o.revision, fireAt: o.fire_at, firedAt: o.fired_at, lateMs: o.late_ms } : null;
  }

  /** 修改内容或时间：revision 加一并重新计算 next_fire_at。expectedRevision 缺省（工具路径）时不做并发检查。 */
  async updateTx(tx: SqlExecutor, ownerId: string, id: string, patch: { text?: unknown; local_datetime?: unknown; timezone?: unknown }, expectedRevision?: unknown): Promise<ScheduleRow> {
    const cur = await this.get(ownerId, id, tx);
    if (expectedRevision !== undefined && cur.revision !== expectedRevision) throw new AppError("revision_conflict", "提醒已被修改，请刷新后重试", { current_revision: cur.revision });
    if (cur.status !== "active") throw new AppError("invalid_request", cur.status === "fired" ? "这个提醒已经触发过了，不能修改" : "这个提醒已经取消了，不能修改");
    const text = patch.text === undefined ? cur.text : cleanText(patch.text);
    const timezone = patch.timezone === undefined ? cur.timezone : patch.timezone;
    assertTimezone(timezone);
    const local = patch.local_datetime === undefined ? cur.localDatetime : patch.local_datetime;
    const timeChanged = patch.local_datetime !== undefined || patch.timezone !== undefined;
    const fire = timeChanged ? localToUtc(local, timezone) : (cur.nextFireAt as number);
    const now = this.#clock.now();
    if (timeChanged && fire <= now) throw new AppError("time_in_past", `这个时间已经过去了：${describeLocal(fire, timezone)}（${timezone}），请给一个未来的时间`);
    if (text === cur.text && fire === cur.nextFireAt && timezone === cur.timezone) return cur;
    await tx.run("UPDATE app_schedules SET text = ?, local_datetime = ?, timezone = ?, next_fire_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?", text, local as string, timezone, fire, now, id);
    return this.get(ownerId, id, tx);
  }
  async update(ownerId: string, id: string, patch: Parameters<ReminderService["updateTx"]>[3], expectedRevision?: unknown): Promise<ScheduleRow> {
    const r = await this.#db.transaction((tx) => this.updateTx(tx, ownerId, id, patch, expectedRevision));
    this.onChange();
    return r;
  }

  /** 取消：天然幂等（已取消再取消返回原状态）；已触发的不能取消。 */
  async cancelTx(tx: SqlExecutor, ownerId: string, id: string): Promise<ScheduleRow> {
    const cur = await this.get(ownerId, id, tx);
    if (cur.status === "cancelled") return cur;
    if (cur.status === "fired") throw new AppError("invalid_request", "这个提醒已经触发过了");
    await tx.run("UPDATE app_schedules SET status = 'cancelled', next_fire_at = NULL, revision = revision + 1, updated_at = ? WHERE id = ?", this.#clock.now(), id);
    return this.get(ownerId, id, tx);
  }
  async cancel(ownerId: string, id: string): Promise<ScheduleRow> {
    const r = await this.#db.transaction((tx) => this.cancelTx(tx, ownerId, id));
    this.onChange();
    return r;
  }

  // ---- 通知（FR-REM-03） ----
  async notifications(ownerId: string, opts: { unread?: boolean; limit?: number } = {}): Promise<NotificationRow[]> {
    const rows = await this.#db.all<{ id: string; kind: string; title: string; body: string; link: string | null; created_at: number; read_at: number | null }>(
      `SELECT id, kind, title, body, link, created_at, read_at FROM app_notifications WHERE owner_id = ? ${opts.unread ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ownerId,
      Math.min(opts.limit ?? 50, 200),
    );
    return rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, createdAt: r.created_at, readAt: r.read_at }));
  }
  async unreadCount(ownerId: string): Promise<number> {
    return (await this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM app_notifications WHERE owner_id = ? AND read_at IS NULL", ownerId))!.n;
  }
  async markRead(ownerId: string, id: string): Promise<void> {
    const n = await this.#db.get("SELECT 1 AS x FROM app_notifications WHERE owner_id = ? AND id = ?", ownerId, id);
    if (!n) throw new AppError("not_found", "通知不存在");
    await this.#db.run("UPDATE app_notifications SET read_at = COALESCE(read_at, ?) WHERE owner_id = ? AND id = ?", this.#clock.now(), ownerId, id);
  }
  async markAllRead(ownerId: string): Promise<void> {
    await this.#db.run("UPDATE app_notifications SET read_at = ? WHERE owner_id = ? AND read_at IS NULL", this.#clock.now(), ownerId);
  }
}

function localToUtcSafe(local: string, tz: string): number {
  try {
    return localToUtc(local, tz);
  } catch {
    return 0; // 终态提醒的显示用；夏令时边界上的历史数据不应让列表失败
  }
}

export type Fired = { ownerId: string; scheduleId: string; occurrenceId: string; notification: NotificationRow; lateMs: number; catchup: boolean };

/**
 * Scheduler（03 §5）：定时器指向 min(next_fire_at)，最长 MAX_SLEEP_MS 兜底检查一次；启动时先补发已到期的。
 * 触发在一个事务里完成：重新读取当前 revision / 状态，插入 occurrence（唯一）、把提醒置为 fired、写通知（dedupe_key = occ:<id>）。
 * 修改会让 revision 加一并改 next_fire_at，所以旧时间到期时不会触发（R4）。
 */
export class Scheduler {
  readonly #db: SqlDatabase;
  readonly #clock: Clock;
  readonly #onFired: (f: Fired) => void;
  #cancel: (() => void) | undefined;
  #running = false;
  #stopped = true;
  #chain: Promise<void> = Promise.resolve();
  constructor(db: SqlDatabase, clock: Clock, onFired: (f: Fired) => void = () => {}) {
    this.#db = db;
    this.#clock = clock;
    this.#onFired = onFired;
  }

  start(): void {
    this.#stopped = false;
    this.wake();
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#cancel?.();
    await this.#chain;
  }
  /** 立即检查一次（启动 / 创建 / 修改之后）。 */
  wake(): void {
    if (this.#stopped) return;
    this.#cancel?.();
    this.#chain = this.#chain.then(async () => void (await this.tick())).catch(() => {});
  }
  /** 触发所有已到期的提醒，然后重新设置定时器。测试可直接 await。 */
  async tick(): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    let fired = 0;
    try {
      for (;;) {
        const now = this.#clock.now();
        const due = await this.#db.all<{ id: string; owner_id: string }>("SELECT id, owner_id FROM app_schedules WHERE status = 'active' AND next_fire_at <= ? ORDER BY next_fire_at ASC, id ASC LIMIT 100", now);
        if (due.length === 0) break;
        for (const d of due) {
          const f = await this.#fire(d.owner_id, d.id);
          if (f) {
            fired++;
            this.#onFired(f);
          }
        }
      }
    } finally {
      this.#running = false;
      await this.#arm();
    }
    return fired;
  }

  /** 距离下一次检查的时间：min(下一次到期, MAX_SLEEP_MS)。 */
  async nextDelay(): Promise<number> {
    const next = await this.#db.get<{ t: number | null }>("SELECT MIN(next_fire_at) AS t FROM app_schedules WHERE status = 'active'");
    return next?.t == null ? MAX_SLEEP_MS : Math.min(MAX_SLEEP_MS, Math.max(0, next.t - this.#clock.now()));
  }

  async #arm(): Promise<void> {
    this.#cancel?.();
    if (this.#stopped) return;
    const delay = await this.nextDelay();
    this.#cancel = this.#clock.setTimer(() => {
      this.#chain = this.#chain.then(async () => void (await this.tick())).catch(() => {});
    }, delay);
  }

  async #fire(ownerId: string, id: string): Promise<Fired | undefined> {
    return this.#db.transaction(async (tx) => {
      const now = this.#clock.now();
      const s = await tx.get<Raw>(`SELECT ${COLS} FROM app_schedules WHERE owner_id = ? AND id = ?`, ownerId, id);
      if (!s || s.status !== "active" || s.next_fire_at === null || s.next_fire_at > now) return undefined; // 已被修改 / 取消 / 时间改到了以后
      const occId = uuidv7(now);
      const late = Math.max(0, now - s.next_fire_at);
      await tx.run("INSERT INTO app_occurrences (id, schedule_id, revision, fire_at, fired_at, late_ms) VALUES (?, ?, ?, ?, ?, ?)", occId, s.id, s.revision, s.next_fire_at, now, late);
      await tx.run("UPDATE app_schedules SET status = 'fired', next_fire_at = NULL, updated_at = ? WHERE id = ?", now, s.id);
      const catchup = late >= CATCHUP_THRESHOLD_MS;
      const body = catchup ? `${s.text}（迟到 ${Math.max(1, Math.round(late / 60_000))} 分钟）` : s.text;
      const nid = uuidv7(now);
      const link = s.document_id ? `/documents/${s.document_id}` : null;
      await tx.run(
        "INSERT INTO app_notifications (id, owner_id, dedupe_key, kind, title, body, link, created_at, read_at) VALUES (?, ?, ?, 'reminder', '提醒', ?, ?, ?, NULL) ON CONFLICT(owner_id, dedupe_key) DO NOTHING",
        nid, ownerId, `occ:${occId}`, body, link, now,
      );
      return { ownerId, scheduleId: s.id, occurrenceId: occId, lateMs: late, catchup, notification: { id: nid, kind: "reminder", title: "提醒", body, link, createdAt: now, readAt: null } };
    });
  }

  /** 触发统计（FR-REM-04：补发与正常触发分开）。 */
  async stats(ownerId?: string): Promise<{ onTime: number; catchup: number; p95LateMs: number }> {
    const rows = await this.#db.all<{ late_ms: number }>(
      `SELECT o.late_ms FROM app_occurrences o ${ownerId ? "JOIN app_schedules s ON s.id = o.schedule_id WHERE s.owner_id = ?" : ""}`,
      ...(ownerId ? [ownerId] : []),
    );
    const normal = rows.filter((r) => r.late_ms < CATCHUP_THRESHOLD_MS).map((r) => r.late_ms).sort((a, b) => a - b);
    return { onTime: normal.length, catchup: rows.length - normal.length, p95LateMs: normal.length === 0 ? 0 : normal[Math.min(normal.length - 1, Math.ceil(normal.length * 0.95) - 1)]! };
  }
}
