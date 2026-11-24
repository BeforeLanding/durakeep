import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createApp } from "../../apps/server/src/app.ts";
import { BackupService } from "../../apps/server/src/backup.ts";
import { EventStore } from "../../apps/server/src/events.ts";
import type { adminHealth } from "../../apps/server/src/health.ts";
import { ConversationDirectory, ConversationService } from "../../packages/conversations/src/index.ts";
import { FakeClock, systemClock } from "../../packages/core/src/index.ts";
import { backupInto, guardDb, migrate, setDeliveryPaused } from "../../packages/db/src/index.ts";
import { enqueue } from "../../packages/jobs/src/index.ts";
import { MemoryService } from "../../packages/memory/src/index.ts";
import { appProfileExtension, openAppDatabase, PiRuntime, startPi } from "../../packages/runtime-pi/src/index.ts";
import { fauxAssistantMessage, fauxProvider } from "../../packages/runtime-pi/src/testing/faux.ts";
import { freePort, get, initOwner, loginCookie, startServer, type Server } from "../support/server.ts";

const origin = "http://127.0.0.1:4777";
type EventPage = Awaited<ReturnType<EventStore["list"]>>;
type Health = Awaited<ReturnType<typeof adminHealth>>;

test("运维接口认证、同毫秒游标、业主隔离、Pi 报告映射与健康字段", async () => {
  const dir = mkdtempSync(join(tmpdir(), "durakeep-ops-"));
  const db = guardDb(await openAppDatabase(join(dir, "app.sqlite")));
  const clock = new FakeClock();
  await migrate(db);
  try {
    const events = new EventStore(db, clock);
    const backup = new BackupService(db, clock, dir, (p) => backupInto(db, p));
    const { app, auth } = createApp({ db, clock, origin, events, backup, orphanedBackgroundConversations: 2 });
    const owner = await auth.initOwner({ password: "fixture password", timezone: "UTC" });
    const { token } = await auth.login("fixture password");
    const get = (path: string) => app.request(path, { headers: { Cookie: `sid=${token}` } });
    const read = async <T>(path: string): Promise<T> => {
      const r = await get(path);
      expect(r.status).toBe(200);
      return await r.json() as T;
    };
    expect((await app.request("/v1/events")).status).toBe(401);
    expect((await app.request("/v1/admin/health")).status).toBe(401);
    expect(await read("/v1/admin/health")).toMatchObject({ last_backup_at: null, delivery_paused: false, orphaned_background_conversations: 2 });
    expect((await get("/v1/events?level=unknown")).status).toBe(400);
    expect((await get("/v1/events?cursor=bad")).status).toBe(400);
    expect((await get("/v1/events?limit=101")).status).toBe(400);

    const example = [
      ["task_faulted", "pi.task_faulted", "warn"], ["task_interrupted", "pi.task_faulted", "warn"],
      ["task_outdated", "pi.task_blocked", "error"], ["migration_failed", "pi.task_blocked", "error"],
      ["extension_error", "pi.extension_error", "warn"], ["task_error", "pi.extension_error", "warn"],
      ["listener_error", "pi.extension_error", "warn"], ["host_error", "pi.extension_error", "warn"],
    ] as const;
    for (const [report_kind] of example) await events.recordPi(owner.id, { report_kind });
    const failureFile = join(dir, "storage-failures.jsonl");
    events.spoolStorageFailure(failureFile, owner.id);
    await events.importStorageFailures(failureFile, owner.id);
    await events.importStorageFailures(failureFile, owner.id);
    await events.record("other-owner", "backup.done", "info", { job_id: "hidden-owner-sentinel" });
    await events.record(owner.id, "backup.done", "info", { job_id: "safe-id" }, "succeeded");
    const page1 = await read<EventPage>("/v1/events?limit=5");
    const page2 = await read<EventPage>(`/v1/events?limit=5&cursor=${page1.next_cursor}`);
    expect(page2.next_cursor).toBeNull();
    const entries = [...page1.items, ...page2.items];
    const ids = entries.map((e) => e.id);
    expect(ids).toEqual([...new Set(ids)].sort().reverse());
    expect(entries).toHaveLength(10);
    for (const [report, kind, level] of example) {
      expect(entries).toContainEqual(expect.objectContaining({ kind, level, ref: expect.objectContaining({ report_kind: report }) }));
    }
    expect(entries).toContainEqual(expect.objectContaining({ kind: "pi.storage_failed", level: "error" }));
    expect(JSON.stringify(entries)).not.toContain("hidden-owner-sentinel");
    expect((await read<EventPage>("/v1/events?level=error")).items).toHaveLength(3);
    await backup.create();
    await setDeliveryPaused(db, true, clock.now());
    for (const status of ["queued", "failed", "succeeded"]) {
      await db.run(
        "INSERT INTO app_jobs (id, owner_id, kind, dedupe_key, input_json, status, next_attempt_at, created_at, updated_at) VALUES (?, ?, 'backup', ?, '{}', ?, ?, ?, ?)",
        status, owner.id, status, status, clock.now(), clock.now(), clock.now(),
      );
    }
    await db.run("INSERT INTO app_notifications (id, owner_id, dedupe_key, kind, title, body, created_at) VALUES ('notification', ?, 'a', 'system', 'test', 'test', ?)", owner.id, clock.now());
    const health = await read<Health>("/v1/admin/health");
    expect(health).toEqual({
      uptime_ms: expect.any(Number), db_size_bytes: expect.any(Number),
      queued_jobs: 1, failed_jobs: 1, unread_notifications: 1, delivery_paused: true,
      last_backup_at: clock.now(), orphaned_background_conversations: 2,
      feishu_configured: false, outbox_pending: 0, outbox_needs_review: 0,
      pi_reports: { total: 9, by_kind: Object.fromEntries([...example.map(([kind]) => kind), "storage_failed"].map((kind) => [kind, 1])) },
    });
    expect(health.db_size_bytes).toBeGreaterThan(0);
    expect(health.uptime_ms).toBeGreaterThanOrEqual(0);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("profile 截断实际经过 faux 渲染，按 owner 和 revision 持久去重", async () => {
  const raw = await openAppDatabase(":memory:");
  const db = guardDb(raw);
  await migrate(db);
  const clock = new FakeClock();
  const memory = new MemoryService(db, clock);
  const events = new EventStore(db, clock);
  const directory = new ConversationDirectory(db);
  const owner = await createApp({ db, clock, origin }).auth.initOwner({ password: "fixture password", timezone: "UTC" });
  const faux = fauxProvider();
  const captured: string[] = [];
  faux.setResponses(Array.from({ length: 4 }, () => (ctx) => {
    captured.push(JSON.stringify(ctx.messages.filter((m) => m.role === "system")));
    return fauxAssistantMessage("好");
  }));
  const extension = appProfileExtension({ conversations: directory, memory, onTruncated: (id, revision) => events.profileTruncated(id, revision) });
  const pi = await startPi({ mode: "test", db: raw, faux, extensions: [extension] });
  const runtime = new PiRuntime(pi, { model: { provider: "faux", modelId: "faux-1" } });
  try {
    const conversations = new ConversationService(db, runtime, clock);
    const make = (n: number) => memory.remember(owner.id, {
      kind: "preference", key: `fixture.${String(n).padStart(2, "0")}`, value: `private-profile-${n}`,
      changedBy: "user", source: { kind: "manual" },
    });
    for (let i = 0; i <= 20; i++) await make(i);
    const run = async () => {
      const c = await conversations.get(owner.id, (await conversations.create(owner.id)).id);
      const s = await runtime.submitInput(c.piConversationId, { text: "收到", requestId: crypto.randomUUID(), steer: false, now: clock.now(), tz: "UTC" });
      expect((await runtime.waitSubmission(s.submissionId)).status).toBe("done");
    };
    await run();
    await run();
    const revision = await memory.setRevision(owner.id);
    await Promise.all([new EventStore(db, clock).profileTruncated(owner.id, revision), events.profileTruncated(owner.id, revision)]);
    const first = await events.list(owner.id, { limit: 20 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ kind: "profile.truncated", ref: { owner_id: owner.id, revision } });
    expect(captured[0]).toContain("private-profile-19");
    expect(captured[0]).not.toContain("private-profile-20");
    expect(JSON.stringify(first)).not.toContain("private-profile");
    await make(21);
    await run();
    expect((await events.list(owner.id, { limit: 20 })).items).toHaveLength(2);
  } finally {
    await runtime.close();
  }
});

test("真实服务启动记录恢复扫描、识别孤儿会话并记录失败备份", async () => {
  const dir = mkdtempSync(join(tmpdir(), "durakeep-ops-server-"));
  let server: Server | undefined;
  try {
    await initOwner(dir);
    const raw = await openAppDatabase(join(dir, "app.sqlite"));
    const db = guardDb(raw);
    const owner = (await db.get<{ id: string }>("SELECT id FROM app_owners LIMIT 1"))!.id;
    const pi = await startPi({ mode: "test", db: raw, faux: fauxProvider() });
    const runtime = new PiRuntime(pi, { model: { provider: "faux", modelId: "faux-1" } });
    const job = await enqueue(db, systemClock.now(), { ownerId: owner, kind: "backup", dedupeKey: "fixture", input: {}, maxAttempts: 1 });
    try {
      const linked = await runtime.createConversation({ kind: "background", job: { id: job.job.id, ownerId: owner } });
      await db.run("UPDATE app_jobs SET pi_conversation_id = ? WHERE owner_id = ? AND id = ?", linked.piConversationId, owner, job.job.id);
      await runtime.createConversation({ kind: "background", job: { id: job.job.id, ownerId: owner } });
      await runtime.createConversation({ kind: "background" }); // 旧版无标记
      await runtime.createConversation({ kind: "chat" });
      new EventStore(db, systemClock).spoolStorageFailure(join(dir, "storage-failures.jsonl"), owner);
    } finally {
      await runtime.close();
    }
    writeFileSync(join(dir, "backups"), "fixture: not a writable backup directory");
    server = await startServer(dir, await freePort());
    const base = server.base;
    const token = await loginCookie(base);
    const read = async <T>(path: string): Promise<T> => {
      const r = await get(base, path, token);
      expect(r.status).toBe(200);
      return await r.json() as T;
    };
    await expect.poll(async () => (await read<EventPage>("/v1/events")).items.map((e) => e.kind)).toEqual(expect.arrayContaining(["recovery.scan", "job.failed", "backup.failed", "pi.storage_failed"]));
    expect(await read("/v1/admin/health")).toMatchObject({
      orphaned_background_conversations: 1, last_backup_at: null, failed_jobs: 1,
      pi_reports: { total: 1, by_kind: { storage_failed: 1 } },
    });
  } finally {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
