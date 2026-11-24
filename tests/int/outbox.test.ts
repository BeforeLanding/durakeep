
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import { createApp, type LogEvent } from "../../apps/server/src/app.ts";
import { EventHub } from "../../apps/server/src/hub.ts";
import { UsageMeter } from "../../apps/server/src/usage.ts";
import { FakeClock, uuidv7 } from "../../packages/core/src/index.ts";
import { guardDb, migrate, setDeliveryPaused } from "../../packages/db/src/index.ts";
import { BlobStore, KnowledgeService } from "../../packages/knowledge/src/index.ts";
import { enqueueFeishu, FeishuWebhookSender, listOutbox, OutboxWorker } from "../../packages/outbox/src/index.ts";
import { ReminderService, Scheduler } from "../../packages/reminders/src/index.ts";
import { openAppDatabase } from "../../packages/runtime-pi/src/index.ts";
import { mockFeishu, MOCK_SECRET, MOCK_TOKEN } from "../support/feishu.ts";

const START = Date.UTC(2026, 10, 6, 7);
const ORIGIN = "http://127.0.0.1:4777";
const PASSWORD = "outbox-test-passphrase";
const DELIVERED = (res: ServerResponse) => res.end('{"code":0}');
const PAYLOAD = { title: "fixture-outbox-payload", localTime: "2026-11-06 07:01 星期五", timezone: "UTC", lateMinutes: 0 };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const release of cleanup.splice(0).reverse()) await release();
});

async function setup(reply: (res: ServerResponse, count: number) => void = DELIVERED, timeoutMs = 3000) {
  const remote = await mockFeishu(reply);
  cleanup.push(remote.close);
  const dir = mkdtempSync(join(tmpdir(), "durakeep-outbox-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const db = guardDb(await openAppDatabase(join(dir, "app.sqlite")));
  cleanup.push(() => db.close());
  await migrate(db);
  const clock = new FakeClock(START);
  const hub = new EventHub();
  const logs: LogEvent[] = [];
  const sender = new FeishuWebhookSender(remote.url, MOCK_SECRET, { testLoopback: true, timeoutMs });
  const reminders = new ReminderService(db, clock);
  const knowledge = new KnowledgeService({ db, clock, blobs: new BlobStore(join(dir, "blobs")) });
  const usage = new UsageMeter(db, clock, async () => ({
    models: { "faux/faux-1": { input: 0, output: 0, cacheRead: 0, cost: { total: 5 } } }, tools: {},
  }), hub);
  const h = createApp({
    db, clock, origin: ORIGIN, reminders, knowledge, usage, hub, feishuConfigured: true,
    wakeOutbox: () => worker.wake(), log: (e) => logs.push(e),
  });
  const owner = (await h.auth.initOwner({ password: PASSWORD, timezone: "UTC" })).id;
  const worker = new OutboxWorker(db, clock, { ownerId: owner, sender, onError: () => logs.push({ level: "error", event: "outbox.worker_failed" }) });
  cleanup.push(() => worker.stop());
  const { token } = await h.auth.login(PASSWORD);
  const call = (path: string, method = "GET", data?: unknown) =>
    h.app.request(path, { method, headers: { Origin: ORIGIN, Cookie: "sid=" + token, "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
  async function read<T>(path: string, method?: string, data?: unknown): Promise<T> {
    const r = await call(path, method, data);
    expect(r.status).toBe(200);
    return await r.json() as T;
  }
  const list = (params = "") => read<Awaited<ReturnType<typeof listOutbox>>>("/v1/outbox" + params);
  const pending = async (ownerId = owner) => {
    const occurrenceId = uuidv7(clock.now());
    await db.transaction((tx) => enqueueFeishu(tx, { ...PAYLOAD, ownerId, occurrenceId, now: clock.now() }));
    return occurrenceId;
  };
  const state = async () => {
    clock.advance(0);
    const { items } = await list();
    return items[0]?.status;
  };
  const mk = (text: string) => reminders.create(owner, { text, timezone: "UTC", local_datetime: "2026-11-06T07:01" });
  return { db, clock, remote, h, owner, worker, reminders, sender, call, read, list, state, pending, mk, logs };
}

test("提醒和 outbox 同事务提交，使用飞书签名并发送计划时间和迟到标记，模型预算用尽也正常投递", async () => {
  const t = await setup();
  const reminder = await t.mk("准备明早的材料");
  expect(await t.read("/v1/usage")).toMatchObject({ exceeded_100: true });
  t.clock.advance(5 * 60_000);
  const failing = new Scheduler(t.db, t.clock, undefined, async (tx, payload) => {
    await enqueueFeishu(tx, payload);
    throw new Error("fixture rollback");
  });
  await expect(failing.tick()).rejects.toThrow("fixture rollback");
  expect((await t.reminders.get(t.owner, reminder.id)).status).toBe("active");
  expect((await t.reminders.notifications(t.owner)).filter(n => n.kind === "reminder")).toHaveLength(0);
  expect((await t.list()).items).toHaveLength(0);

  t.worker.start();
  const scheduler = new Scheduler(t.db, t.clock, () => t.worker.wake(), enqueueFeishu);
  expect(await scheduler.tick()).toBe(1);
  expect(await scheduler.tick()).toBe(0);
  await expect.poll(t.state).toBe("succeeded");
  const timestamp = String(t.clock.now() / 1000);
  const sign = createHmac("sha256", timestamp + "\n" + MOCK_SECRET).digest("base64");
  expect(t.remote.requests).toEqual([{
    msg_type: "text", timestamp, sign,
    content: { text: "提醒：准备明早的材料\n2026-11-06 07:01 星期五 UTC\n迟到 4 分钟" },
  }]);
  expect(await t.read("/v1/admin/health")).toMatchObject({ feishu_configured: true, outbox_pending: 0, outbox_needs_review: 0 });
});

test("429 和 503 按退避窗口重试，兼容旧式成功码", async () => {
  const t = await setup((res, count) => {
    if (count <= 2) res.writeHead(count === 1 ? 429 : 503).end();
    else res.end('{"StatusCode":0}');
  });
  await t.pending();
  t.worker.start();
  const expectAttempt = async (attempt: number, code: string, delay: number) => {
    await expect.poll(async () => {
      await t.state();
      return (await t.list()).items[0];
    }).toMatchObject({ status: "pending", attempts: attempt, next_attempt_at: t.clock.now() + delay, error_code: code });
    t.clock.advance(delay - 1);
    expect(t.remote.requests).toHaveLength(attempt);
    t.clock.advance(1);
  };
  await expectAttempt(1, "rate_limited", 30_000);
  await expectAttempt(2, "service_unavailable", 120_000);
  await expect.poll(t.state).toBe("succeeded");
  expect((await t.list()).items[0]?.attempts).toBe(3);
  expect(t.remote.requests).toHaveLength(3);
});

test("已明确拒绝的业务码直接失败，人工重试清零次数并唤醒 worker", async () => {
  const t = await setup((res, n) => res.end(n === 1 ? '{"code":19021,"msg":"unsafe remote message"}' : '{"code":0}'));
  await t.pending();
  t.worker.start();
  await expect.poll(t.state).toBe("failed");
  const row = (await t.list()).items[0]!;
  expect(row).toMatchObject({ attempts: 1, error_code: "signature_rejected" });
  expect(JSON.stringify(row)).not.toContain("unsafe remote message");
  expect((await t.call("/v1/outbox/" + row.id + "/resolve", "POST", { resolution: "succeeded" })).status).toBe(409);
  expect(await t.read("/v1/outbox/" + row.id + "/retry", "POST")).toMatchObject({ status: "pending", attempts: 0 });
  await expect.poll(t.state).toBe("succeeded");
  expect(t.remote.requests).toHaveLength(2);
});

test("读响应超时进入待核对，无自动重发，并能从 API 标记已送达、放弃或重新发送", async () => {
  const t = await setup((res, count) => {
    if (count > 3) { DELIVERED(res); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"code":');
  }, 300);
  for (let i = 0; i < 3; i++) await t.pending();
  t.worker.start();
  await expect.poll(async () => (await t.list("?status=needs_review")).items.length, { timeout: 7000 }).toBe(3);
  expect(await t.read("/v1/admin/health")).toMatchObject({ outbox_needs_review: 3 });
  expect(await t.read("/v1/events")).toMatchObject({ items: Array.from({ length: 3 }, () =>
    expect.objectContaining({ kind: "outbox.needs_review", level: "warn", ref: expect.objectContaining({ previous_status: "unknown" }) })) });
  expect((await t.reminders.notifications(t.owner)).filter(n => n.kind === "system")).toHaveLength(3);
  t.clock.advance(10 * 60_000);
  expect(t.remote.requests).toHaveLength(3);
  const [first, second, third] = (await t.list("?status=needs_review")).items;
  expect(await t.read("/v1/outbox/" + first!.id + "/resolve", "POST", { resolution: "succeeded" })).toMatchObject({ status: "succeeded" });
  expect(await t.read("/v1/outbox/" + second!.id + "/resolve", "POST", { resolution: "failed" })).toMatchObject({ status: "failed", error_code: "abandoned" });
  expect(await t.read("/v1/outbox/" + third!.id + "/retry", "POST")).toMatchObject({ status: "pending", attempts: 0 });
  await expect.poll(async () => (await t.list("?status=succeeded")).items.length).toBe(2);
  expect(t.remote.requests).toHaveLength(4);
});

test("暂停时已在队列里的投递不领取，恢复接口唤醒 worker，且日志、API 与导出不含凭据或载荷", async () => {
  const t = await setup();
  await setDeliveryPaused(t.db, true, t.clock.now());
  const occurrence = await t.pending();
  await t.db.transaction((tx) => enqueueFeishu(tx, { ...PAYLOAD, occurrenceId: occurrence, ownerId: t.owner, now: t.clock.now() }));
  t.worker.start();
  await delay(50); // 即使没有人工操作也留时间给启动扫描与领取检查
  expect(t.remote.requests).toHaveLength(0);
  expect((await t.list()).items).toEqual([expect.objectContaining({ status: "pending", attempts: 0 })]);
  expect(await t.read("/v1/admin/health")).toMatchObject({ delivery_paused: true, outbox_pending: 1 });
  expect(await t.read("/v1/admin/delivery/resume", "POST")).toEqual({ delivery_paused: false });
  await expect.poll(t.state).toBe("succeeded");
  const exported = await t.call("/v1/export");
  expect(exported.status).toBe(200);
  const zip = Buffer.from(await exported.arrayBuffer()).toString("utf8");
  for (const sentinel of [t.remote.url, MOCK_TOKEN, MOCK_SECRET, PAYLOAD.title]) {
    expect(zip).not.toContain(sentinel);
    expect(JSON.stringify(await t.list())).not.toContain(sentinel);
    expect(JSON.stringify(t.logs)).not.toContain(sentinel);
  }
});

test("仅当前 owner 可分页查看和操作投递，认证及参数校验保持一致", async () => {
  const t = await setup();
  const other = uuidv7();
  await t.db.run("INSERT INTO app_owners (id, display_name, created_at) VALUES (?, 'other', ?)", other, t.clock.now());
  await t.pending(other);
  const foreign = (await listOutbox(t.db, other, { limit: 10 })).items[0]!.id;
  await t.pending();
  await t.pending();
  const first = await t.list("?limit=1");
  expect(first.items).toHaveLength(1);
  expect(first.next_cursor).toBe(first.items[0]?.id);
  const second = await t.list("?limit=1&cursor=" + first.next_cursor);
  expect(second.items).toHaveLength(1);
  expect(second.next_cursor).toBeNull();
  expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
  expect((await t.h.app.request("/v1/outbox")).status).toBe(401);
  expect((await t.call("/v1/outbox/" + foreign + "/retry", "POST")).status).toBe(404);
  expect((await t.call("/v1/outbox/" + foreign + "/resolve", "POST", { resolution: "failed" })).status).toBe(404);
  expect((await t.call("/v1/outbox?status=bad")).status).toBe(400);
  expect((await t.call("/v1/outbox?cursor=bad")).status).toBe(400);
  expect((await t.call("/v1/outbox/" + first.items[0]!.id + "/retry", "POST")).status).toBe(409);
  expect((await t.call("/v1/outbox/" + first.items[0]!.id + "/resolve", "POST", { resolution: "bad" })).status).toBe(400);
});
