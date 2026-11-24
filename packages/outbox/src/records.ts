
import { AppError, uuidv7 } from "@durakeep/core";
import type { SqlDatabase, SqlExecutor } from "@durakeep/db";
import type { ReminderDelivery } from "./feishu.ts";

export type OutboxStatus = "pending" | "dispatching" | "succeeded" | "failed" | "unknown" | "needs_review";
const STATUSES = new Set<string>(["pending", "dispatching", "succeeded", "failed", "unknown", "needs_review"]);
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const PUBLIC = "id, channel, idempotency_key, status, attempts, next_attempt_at, error_code, created_at, updated_at";
type PublicRow = {
  id: string; channel: "feishu_webhook"; idempotency_key: string; status: OutboxStatus; attempts: number;
  next_attempt_at: number; error_code: string | null; created_at: number; updated_at: number;
};

function present({ idempotency_key, next_attempt_at, ...row }: PublicRow) {
  return { ...row, occurrence_id: idempotency_key.slice(4), next_attempt_at: row.status === "pending" ? next_attempt_at : null };
}

export async function enqueueFeishu(tx: SqlExecutor, input: ReminderDelivery & { ownerId: string; occurrenceId: string; now: number }) {
  const { ownerId, occurrenceId, now, title, localTime, timezone, lateMinutes } = input;
  await tx.run(
    "INSERT INTO app_outbox (id, owner_id, channel, idempotency_key, payload_json, status, next_attempt_at, created_at, updated_at) " +
    "VALUES (?, ?, 'feishu_webhook', ?, ?, 'pending', ?, ?, ?) ON CONFLICT(owner_id, channel, idempotency_key) DO NOTHING",
    uuidv7(now), ownerId, "occ:" + occurrenceId, JSON.stringify({ title, localTime, timezone, lateMinutes }), now, now, now,
  );
}

export async function listOutbox(db: SqlExecutor, ownerId: string, filters: { status?: string; cursor?: string; limit: number }) {
  const { status, cursor, limit } = filters;
  if (status !== undefined && !STATUSES.has(status)) throw new AppError("invalid_request", "无效的投递状态");
  if (cursor !== undefined && !ID.test(cursor)) throw new AppError("invalid_request", "cursor 无效");
  const rows = await db.all<PublicRow>(
    "SELECT " + PUBLIC + " FROM app_outbox WHERE owner_id = ? " +
    (status === undefined ? "" : "AND status = ? ") + (cursor === undefined ? "" : "AND id < ? ") +
    "ORDER BY id DESC LIMIT ?",
    ownerId, ...(status === undefined ? [] : [status]), ...(cursor === undefined ? [] : [cursor]), limit + 1,
  );
  const page = rows.slice(0, limit);
  return { items: page.map(present), next_cursor: rows.length > limit ? page.at(-1)!.id : null };
}

export async function changeOutbox(db: SqlDatabase, ownerId: string, id: string, action: "retry" | "succeeded" | "failed", now: number) {
  return db.transaction(async (tx) => {
    const row = await tx.get<PublicRow>("SELECT " + PUBLIC + " FROM app_outbox WHERE owner_id = ? AND id = ?", ownerId, id);
    if (!row) throw new AppError("not_found", "外部投递不存在");
    const retry = action === "retry";
    if (row.status !== "needs_review" && !(retry && row.status === "failed")) {
      throw new AppError("invalid_state", "当前投递状态不支持该操作");
    }
    const status = retry ? "pending" : action;
    const attempts = retry ? 0 : row.attempts;
    const error_code = action === "failed" ? "abandoned" : null;
    await tx.run(
      "UPDATE app_outbox SET status = ?, attempts = ?, next_attempt_at = ?, updated_at = ?, error_code = ? WHERE owner_id = ? AND id = ?",
      status, attempts, now, now, error_code, ownerId, id,
    );
    return present({ ...row, status, attempts, error_code, updated_at: now, next_attempt_at: now });
  });
}

export async function outboxCounts(tx: SqlExecutor, ownerId: string) {
  const row = await tx.get<{ outbox_pending: number; outbox_needs_review: number }>(
    "SELECT COUNT(*) FILTER (WHERE status = 'pending') AS outbox_pending, " +
    "COUNT(*) FILTER (WHERE status = 'needs_review') AS outbox_needs_review FROM app_outbox WHERE owner_id = ?", ownerId,
  );
  return row ?? { outbox_pending: 0, outbox_needs_review: 0 };
}
