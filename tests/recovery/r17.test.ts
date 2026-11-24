
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { FakeClock } from "../../packages/core/src/index.ts";
import { guardDb, setDeliveryPaused } from "../../packages/db/src/index.ts";
import { ReminderService } from "../../packages/reminders/src/index.ts";
import { openAppDatabase } from "../../packages/runtime-pi/src/index.ts";
import { mockFeishu, MOCK_SECRET, MOCK_TOKEN } from "../support/feishu.ts";
import { freePort, get, initOwner, loginCookie, post, startServer, type Server } from "../support/server.ts";

const REPEAT = Number(process.env.REPEAT ?? 20);
const REMINDER = "r17-fixture-reminder-body";

test("R17 × " + REPEAT + "：远端确认后崩溃，重启进入待核对且无重复发送", async () => {
  const mock = await mockFeishu((res) => res.end('{"code":0}'));
  const env = { FEISHU_ALLOW_LOOPBACK: "1", FEISHU_WEBHOOK_URL: mock.url, FEISHU_WEBHOOK_SECRET: MOCK_SECRET };
  try {
    for (let i = 0; i < REPEAT; i++) {
      const dir = mkdtempSync(join(tmpdir(), "durakeep-r17-"));
      let server: Server | undefined;
      const before = mock.requests.length;
      try {
        await initOwner(dir);
        const now = Date.now();
        const db = guardDb(await openAppDatabase(join(dir, "app.sqlite")));
        const owner = (await db.get<{ id: string }>("SELECT id FROM app_owners LIMIT 1"))!.id;
        try {
          await new ReminderService(db, new FakeClock(now - 60 * 60_000)).create(owner, {
            text: REMINDER, timezone: "UTC", local_datetime: new Date(now - 5 * 60_000).toISOString().slice(0, 16),
          });
          await setDeliveryPaused(db, true, now);
        } finally {
          await db.close();
        }
        const port = await freePort();
        server = await startServer(dir, port, { ...env, FAULT_POINT: "outbox.after_send" });
        const base = server.base;
        const session = await loginCookie(base);
        await post(base, "/v1/admin/delivery/resume", session, {}).then(r => expect(r.status).toBe(200), () => {
          // 服务可能在 HTTP 响应送出前终止。
        });
        const crashed = await Promise.race([server.exited.then(() => true), delay(8000, false, { ref: false })]);
        expect(crashed).toBe(true);
        expect(mock.requests).toHaveLength(before + 1);
        const crashLogs = server.out();
        server = undefined;

        const afterCrash = guardDb(await openAppDatabase(join(dir, "app.sqlite")));
        try {
          expect(await afterCrash.get("SELECT status, attempts FROM app_outbox WHERE owner_id = ?", owner)).toEqual({
            status: "dispatching", attempts: 1,
          });
        } finally {
          await afterCrash.close();
        }
        server = await startServer(dir, port, { ...env, FAULT_POINT: "" });
        const response = await get(base, "/v1/outbox", session);
        expect(response.status).toBe(200);
        const { items } = await response.json() as { items: { id: string; status: string; attempts: number }[] };
        expect(items).toEqual([expect.objectContaining({ status: "needs_review", attempts: 1, error_code: "send_interrupted" })]);
        const events = await (await get(base, "/v1/events", session)).json();
        expect(events).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({
          kind: "outbox.needs_review", level: "warn",
          ref: expect.objectContaining({ outbox_id: items[0]!.id, previous_status: "unknown" }),
        })]) });
        const notifications = await (await get(base, "/v1/notifications", session)).json() as { items: { title: string }[] };
        expect(notifications.items.filter(n => n.title === "飞书投递待核对")).toHaveLength(1);
        const resolved = await post(base, "/v1/outbox/" + items[0]!.id + "/resolve", session, { resolution: "succeeded" });
        expect(resolved.status).toBe(200);
        expect(await resolved.json()).toMatchObject({ status: "succeeded", attempts: 1 });
        expect(mock.requests).toHaveLength(before + 1);
        if (i === 0) {
          const exported = await get(base, "/v1/export", session);
          expect(exported.status).toBe(200);
          const zip = Buffer.from(await exported.arrayBuffer()).toString("utf8");
          for (const value of [mock.url, MOCK_TOKEN, MOCK_SECRET]) {
            expect(zip).not.toContain(value);
            expect(crashLogs + server.out()).not.toContain(value);
          }
          expect(crashLogs + server.out()).not.toContain(REMINDER);
          expect(zip).not.toContain("app_outbox");
        }
      } finally {
        await server?.stop();
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
    expect(mock.requests).toHaveLength(REPEAT);
  } finally {
    await mock.close();
  }
}, Math.max(60_000, 20_000 * REPEAT));
