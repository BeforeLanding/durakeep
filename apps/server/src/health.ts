import { deliveryPaused, type SqlDatabase } from "@durakeep/db";
import { outboxCounts } from "@durakeep/outbox";
import type { EventStore } from "./events.ts";

export async function adminHealth(db: SqlDatabase, events: EventStore, ownerId: string, lastBackupAt: number | null, orphaned: number, feishuConfigured: boolean) {
  return db.transaction(async (tx) => {
    const pages = await tx.get<{ page_count: number }>("PRAGMA page_count");
    const pageSize = await tx.get<{ page_size: number }>("PRAGMA page_size");
    const jobs = await tx.get<{ queued: number; failed: number }>(
      "SELECT COUNT(*) FILTER (WHERE status = 'queued') AS queued, COUNT(*) FILTER (WHERE status = 'failed') AS failed FROM app_jobs WHERE owner_id = ?",
      ownerId,
    );
    const unread = await tx.get<{ count: number }>("SELECT COUNT(*) AS count FROM app_notifications WHERE owner_id = ? AND read_at IS NULL", ownerId);
    return {
      uptime_ms: Math.floor(process.uptime() * 1000),
      db_size_bytes: (pages?.page_count ?? 0) * (pageSize?.page_size ?? 0),
      queued_jobs: jobs?.queued ?? 0,
      failed_jobs: jobs?.failed ?? 0,
      unread_notifications: unread?.count ?? 0,
      last_backup_at: lastBackupAt,
      pi_reports: await events.piCounts(tx, ownerId),
      delivery_paused: await deliveryPaused(tx),
      orphaned_background_conversations: orphaned,
      feishu_configured: feishuConfigured,
      ...await outboxCounts(tx, ownerId),
    };
  });
}
