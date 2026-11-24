import { AppError, type Json } from "@durakeep/core";
import { onceStrict, type SqlDatabase } from "@durakeep/db";
import type { NotificationRow, ReminderService, ScheduleRow, Occurrence } from "@durakeep/reminders";
import type { Hono } from "hono";
import type { AppEnv } from "./app.ts";
import type { EventHub } from "./hub.ts";
import { readJson } from "./http.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const presentReminder = (reminders: ReminderService, r: ScheduleRow & { lastOccurrence?: Occurrence | null }) => {
  const e = reminders.echo(r);
  return {
    id: r.id,
    text: r.text,
    local: e.local,
    timezone: r.timezone,
    local_datetime: r.localDatetime,
    next_fire_at: r.nextFireAt,
    revision: r.revision,
    status: r.status,
    document_id: r.documentId,
    last_occurrence: r.lastOccurrence ? { fire_at: r.lastOccurrence.fireAt, fired_at: r.lastOccurrence.firedAt, late_ms: r.lastOccurrence.lateMs } : null,
  };
};
const presentNotification = (n: NotificationRow) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, created_at: n.createdAt, read: n.readAt !== null });

/** 提醒与通知接口（06 §6）。 */
export function mountReminderRoutes(app: Hono<AppEnv>, deps: { db: SqlDatabase; hub: EventHub }, reminders: ReminderService) {
  app.get("/v1/reminders", async (c) => {
    const rows = await reminders.list(c.get("owner").id, { status: c.req.query("status") });
    return c.json({ items: rows.map((r) => presentReminder(reminders, r)), next_cursor: null });
  });

  app.post("/v1/reminders", async (c) => {
    const owner = c.get("owner");
    const body = (await readJson(c)) as Record<string, unknown> | null;
    const crid = body?.client_request_id;
    if (typeof crid !== "string" || !UUID.test(crid)) throw new AppError("invalid_request", "client_request_id 必须是 UUID", { issues: [{ path: "client_request_id" }] });
    const args = { text: body?.text ?? null, local_datetime: body?.local_datetime ?? null, timezone: body?.timezone ?? null, document_id: body?.document_id ?? null } as Json;
    const r = await onceStrict(deps.db, owner.id, `http:reminder:${crid}`, "reminder_create", args, async (tx) => {
      const row = await reminders.createTx(tx, owner.id, { text: body?.text, local_datetime: body?.local_datetime, timezone: body?.timezone === undefined ? owner.timezone : body.timezone, document_id: body?.document_id });
      return { id: row.id } satisfies Json;
    });
    reminders.onChange();
    return c.json(presentReminder(reminders, await reminders.get(owner.id, (r.result as { id: string }).id)), r.deduplicated ? 200 : 201);
  });

  app.patch("/v1/reminders/:id", async (c) => {
    const body = (await readJson(c)) as { text?: unknown; local_datetime?: unknown; timezone?: unknown; expected_revision?: unknown } | null;
    if (typeof body?.expected_revision !== "number") throw new AppError("invalid_request", "需要 expected_revision", { issues: [{ path: "expected_revision" }] });
    return c.json(presentReminder(reminders, await reminders.update(c.get("owner").id, c.req.param("id"), body, body.expected_revision)));
  });
  app.post("/v1/reminders/:id/cancel", async (c) => c.json(presentReminder(reminders, await reminders.cancel(c.get("owner").id, c.req.param("id")))));

  const publishUnread = async (ownerId: string) => deps.hub.publish({ ownerId, event: "unread", data: { count: await reminders.unreadCount(ownerId) } });
  app.get("/v1/notifications", async (c) => {
    const id = c.get("owner").id;
    const unread = c.req.query("unread") === "1";
    return c.json({ items: (await reminders.notifications(id, { unread })).map(presentNotification), unread: await reminders.unreadCount(id) });
  });
  app.post("/v1/notifications/read-all", async (c) => {
    await reminders.markAllRead(c.get("owner").id);
    await publishUnread(c.get("owner").id);
    return c.body(null, 204);
  });
  app.post("/v1/notifications/:id/read", async (c) => {
    await reminders.markRead(c.get("owner").id, c.req.param("id"));
    await publishUnread(c.get("owner").id);
    return c.body(null, 204);
  });
}
