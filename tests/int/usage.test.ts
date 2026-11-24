import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createApp } from "../../apps/server/src/app.ts";
import { BackupService } from "../../apps/server/src/backup.ts";
import { EventHub, type HubEvent } from "../../apps/server/src/hub.ts";
import { BUDGET_WARNING, UsageMeter } from "../../apps/server/src/usage.ts";
import { ConversationService, IngressService } from "../../packages/conversations/src/index.ts";
import { FakeClock, type UsageSummary } from "../../packages/core/src/index.ts";
import { guardDb, migrate } from "../../packages/db/src/index.ts";
import { BackgroundModel, enqueue, getJob, JobWorker, type JobContext } from "../../packages/jobs/src/index.ts";
import { BlobStore, createChunkIndexer, KnowledgeService } from "../../packages/knowledge/src/index.ts";
import { ExtractionService, MemoryService } from "../../packages/memory/src/index.ts";
import { ReminderService, Scheduler } from "../../packages/reminders/src/index.ts";
import { openAppDatabase, PiRuntime, startPi } from "../../packages/runtime-pi/src/index.ts";
import { fauxAssistantMessage, fauxProvider } from "../../packages/runtime-pi/src/testing/faux.ts";
import { freePort, get, initOwner, loginCookie, post, startServer, type Server } from "../support/server.ts";

const START = Date.UTC(2026, 10, 30, 23);
const DECEMBER = Date.UTC(2026, 11, 1);
const FLASH = "deepseek/deepseek-flash";
const PRO = "deepseek/deepseek-v4-pro";
const FAUX = "faux/faux-1";
const counters = (input: number, output: number, cacheRead: number, total: number) => ({ input, output, cacheRead, cost: { total } });

test("真实服务进程重启后保留已同步的 faux 用量，启动模型设置也只影响选项", async () => {
  const dir = mkdtempSync(join(tmpdir(), "durakeep-usage-server-"));
  let server: Server | undefined;
  try {
    await initOwner(dir);
    const port = await freePort();
    server = await startServer(dir, port, { CHAT_MODEL: "deepseek-v4-pro" });
    const base = server.base;
    const cookie = await loginCookie(base);
    const settings = await get(base, "/v1/settings", cookie);
    expect(settings.status).toBe(200);
    expect(await settings.json()).toMatchObject({ chat_model: "deepseek-v4-pro" });
    const created = await post(base, "/v1/conversations", cookie, {});
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    const sent = await post(base, `/v1/conversations/${id}/messages`, cookie, { client_request_id: crypto.randomUUID(), text: "无需付费的计量验证" });
    expect(sent.status).toBe(202);
    let first: { models: { model: string; output_tokens: number }[]; month: string } | undefined;
    await expect.poll(async () => {
      const usage = await get(base, "/v1/usage", cookie);
      expect(usage.status).toBe(200);
      first = await usage.json() as typeof first;
      return first?.models[0]?.output_tokens ?? 0;
    }, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(first?.models.map((row) => row.model)).toEqual([FAUX]);
    await server.stop();
    server = undefined;
    server = await startServer(dir, port, { CHAT_MODEL: "deepseek-v4-pro" });
    const after = await get(base, `/v1/usage?month=${first!.month}`, cookie);
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual(first);
  } finally {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("累计用量按差额入账，同步并发及重开数据库不重复，换月只记新增用量", async () => {
  const dir = mkdtempSync(join(tmpdir(), "durakeep-ledger-"));
  const path = join(dir, "app.sqlite");
  const clock = new FakeClock(START);
  const hub = new EventHub();
  const owner = "ledger-owner";
  let db = guardDb(await openAppDatabase(path));
  try {
    await migrate(db);
    let readings: UsageSummary = { models: { [FLASH]: counters(100, 20, 30, 0), [PRO]: counters(10, 5, 1, 0) }, tools: {} };
    let meter = new UsageMeter(db, clock, async () => readings, hub);
    expect((await meter.sync(owner, true)).models).toEqual([]); // 升级之前的历史不能从累计数据恢复月份
    readings = {
      models: { [FLASH]: counters(1_000_100, 1_000_020, 1_000_030, 0), [PRO]: counters(1_000_010, 5, 1, 0.5) },
      tools: { ignored_tool: { cost: { total: 100 } } },
    };
    await Promise.all([meter.sync(owner), meter.sync(owner), meter.sync(owner)]);
    const nov = await meter.get(owner, "2026-11");
    expect(nov.models).toEqual([
      { model: FLASH, input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000, cost_usd: 1.506 },
      { model: PRO, input_tokens: 1_000_000, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0.5 },
    ]);
    expect(nov.total_cost_usd).toBeCloseTo(2.006, 12);
    await db.close();
    db = guardDb(await openAppDatabase(path));
    meter = new UsageMeter(db, clock, async () => readings, hub);
    expect(await meter.sync(owner, true)).toEqual(nov);
    clock.advance(DECEMBER - clock.now());
    expect(await meter.get(owner)).toMatchObject({ month: "2026-12", models: [], total_cost_usd: 0, warning_80: false, exceeded_100: false });
    readings.models[PRO] = counters(1_000_010, 100_005, 1, 0.5); // 累计 reported cost 没变化，使用新增 token 的目录价
    const dec = await meter.get(owner);
    expect(dec.models).toMatchObject([{ model: PRO, input_tokens: 0, output_tokens: 100_000, cache_read_tokens: 0 }]);
    expect(dec.total_cost_usd).toBeCloseTo(0.396, 12);
    expect(await meter.get(owner, "2026-11")).toEqual(nov);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("FR-OPS-03：设置联动，80/100 通知去重，模型作业挂起后可由预算或换月恢复", async () => {
  const dir = mkdtempSync(join(tmpdir(), "durakeep-budget-"));
  const clock = new FakeClock(START);
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  const db = guardDb(raw);
  await migrate(db);
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage("零费用应答")));
  const pi = await startPi({ mode: "test", db: raw, faux });
  const runtime = new PiRuntime(pi, { model: { provider: "faux", modelId: "faux-1" } });
  const conversations = new ConversationService(db, runtime, clock);
  const ingress = new IngressService(db, runtime, clock, conversations);
  const reminder = new ReminderService(db, clock);
  const scheduler = new Scheduler(db, clock);
  const hub = new EventHub();
  const events: HubEvent[] = [];
  hub.subscribe((event) => events.push(event));
  const background = new BackgroundModel(db, clock, () => runtime);
  const backup = new BackupService(db, clock, dir, (path) => runtime.backupInto(path));
  const knowledge = new KnowledgeService({
    db, clock, blobs: new BlobStore(join(dir, "blobs")), indexer: createChunkIndexer(db), wake: () => worker.wake(),
  });

  let billed = 0;
  let paused = false;
  const meter = new UsageMeter(db, clock, async () => {
    const u = await runtime.usage();
    return { ...u, models: { ...u.models, [FAUX]: { ...(u.models[FAUX] ?? counters(0, 0, 0, 0)), cost: { total: billed } } } };
  }, hub, (_, isPaused) => {
    paused = isPaused;
    worker.setModelJobsPaused(isPaused);
  });
  const extraction = new ExtractionService({
    db, clock, background, memory: new MemoryService(db, clock), runtime: () => runtime, wake: () => worker.wake(), canScan: () => !paused,
  });
  const origin = "http://127.0.0.1:4777";
  const h = createApp({ db, clock, origin, usage: meter, chatModel: "deepseek-v4-pro", chat: { conversations, ingress, runtime }, reminders: reminder, knowledge, backup, hub, wakeJobs: () => worker.wake() });
  const owner = await h.auth.initOwner({ password: "a fixture passphrase", timezone: "Asia/Shanghai" });
  const { token } = await h.auth.login("a fixture passphrase");
  const ask = async (ctx: JobContext) => {
    await background.ask(ctx, "test", { instructions: "fixture", prompt: "背景测试" });
  };
  const worker = new JobWorker(db, clock, { ...knowledge.handlers(), backup: backup.handler, summarize: ask, extract_memory: ask }, {
    ownerId: owner.id, refreshModelBudget: async () => { await meter.sync(owner.id); },
  });
  const enqueueModel = (kind: "summarize" | "extract_memory") => db.transaction((tx) => enqueue(tx, clock.now(), {
    ownerId: owner.id, kind, dedupeKey: crypto.randomUUID(), input: {},
  }));
  const call = (method: string, path: string, body?: unknown) => h.app.request(path, {
    method, headers: { Origin: origin, Cookie: `sid=${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async <T>(response: Response | Promise<Response>, status = 200): Promise<T> => {
    const r = await response;
    expect(r.status).toBe(status);
    return await r.json() as T;
  };
  const failOnSync = (e: unknown) => { throw e; };
  const stop = meter.start(owner.id, failOnSync);
  worker.start();
  runtime.resume();
  try {
    expect((await h.app.request("/v1/usage")).status).toBe(401);
    expect(await json(call("GET", "/v1/settings"))).toEqual({ chat_model: "deepseek-v4-pro", monthly_budget_usd: 5, timezone: "Asia/Shanghai", backup_keep: 7 });
    for (const patch of [
      { chat_model: "faux-1" }, { monthly_budget_usd: 0 }, { monthly_budget_usd: "3" }, { monthly_budget_usd: -1 },
      { backup_keep: 1.5 }, { backup_keep: 0 }, { timezone: "Mars/Base" }, { timezone: "+08:00" }, { owner_id: "other" },
    ]) await json(call("PATCH", "/v1/settings", patch), 400);
    await json(call("GET", "/v1/usage?month=2026-13"), 400);
    expect(await json(call("PATCH", "/v1/settings", { timezone: "UTC", chat_model: "deepseek-flash", backup_keep: 2 }))).toEqual({
      chat_model: "deepseek-flash", monthly_budget_usd: 5, timezone: "UTC", backup_keep: 2,
    });
    expect(await json(call("GET", "/v1/me"))).toMatchObject({ timezone: "UTC" });

    billed = 4;
    expect(await json(call("GET", "/v1/usage"))).toMatchObject({ month: "2026-11", usage_ratio: 0.8, warning_80: true, exceeded_100: false });
    await json(call("GET", "/v1/usage"));
    expect(events.filter((e) => e.event === "notification")).toHaveLength(1);
    expect(events.filter((e) => e.event === "unread").at(-1)?.data).toEqual({ count: 1 });
    billed = 5;
    expect(await json(call("GET", "/v1/usage"))).toMatchObject({ usage_ratio: 1, exceeded_100: true });
    expect(events.filter((e) => e.event === "budget").at(-1)?.data).toEqual({ budget_warning: BUDGET_WARNING });

    const pending = [await enqueueModel("summarize"), await enqueueModel("extract_memory")];
    const ingested = await json<{ job_id: string; document_id: string }>(call("POST", "/v1/documents", {
      client_request_id: crypto.randomUUID(), type: "text", text: "预算暂停时仍能采集",
    }), 202);
    for (let i = 0; i < 3; i++) {
      const { job_id } = await json<{ job_id: string }>(call("POST", "/v1/admin/backup"), 202);
      await worker.idle();
      expect(await getJob(db, owner.id, job_id)).toMatchObject({ status: "succeeded", kind: "backup" });
    }
    expect(readdirSync(join(dir, "backups")).filter((name) => name.endsWith(".sqlite"))).toHaveLength(2);
    expect(await getJob(db, owner.id, ingested.job_id)).toMatchObject({ status: "succeeded", kind: "ingest_text" });
    const purge = await json<{ job_id: string }>(call("DELETE", `/v1/documents/${ingested.document_id}`), 202);
    await worker.idle();
    expect(await getJob(db, owner.id, purge.job_id)).toMatchObject({ status: "succeeded", kind: "purge_document" });
    for (const { job } of pending) expect(await getJob(db, owner.id, job.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(faux.state.callCount).toBe(0);
    expect(await extraction.scan()).toBe(0);

    const due = await json<{ next_fire_at: number }>(call("POST", "/v1/reminders", {
      client_request_id: crypto.randomUUID(), text: "无需模型的提醒", local_datetime: "2026-11-30T23:01",
    }), 201);
    expect(due).toMatchObject({ timezone: "UTC" });
    clock.advance(due.next_fire_at - clock.now());
    expect(await scheduler.tick()).toBe(1);
    const conv = await json<{ id: string }>(call("POST", "/v1/conversations", {}), 201);
    const sent = await json<{ submission_id: string }>(call("POST", `/v1/conversations/${conv.id}/messages`, { client_request_id: crypto.randomUUID(), text: "交互仍可用" }), 202);
    expect(sent).toMatchObject({ budget_warning: BUDGET_WARNING });
    expect(await runtime.waitSubmission(sent.submission_id)).toEqual({ status: "done", answerText: "零费用应答" });
    const { piConversationId } = await conversations.get(owner.id, conv.id);
    expect((await runtime.loadEarlier(piConversationId, undefined, 10)).entries).toContainEqual(expect.objectContaining({ kind: "user", tz: "UTC" }));
    expect(Object.keys((await runtime.usage()).models)).toEqual([FAUX]);
    expect(events.filter((e) => e.event === "notification")).toHaveLength(2);
    expect((await reminder.notifications(owner.id)).map((n) => n.kind).sort()).toEqual(["reminder", "system", "system"]);

    await json(call("PATCH", "/v1/settings", { monthly_budget_usd: 10 }));
    expect(events.filter((e) => e.event === "budget").at(-1)?.data).toEqual({ budget_warning: null });
    await worker.idle();
    for (const { job } of pending) expect(await getJob(db, owner.id, job.id)).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(faux.state.callCount).toBe(3);
    await json(call("PATCH", "/v1/settings", { monthly_budget_usd: 5 }));
    const decemberJob = await enqueueModel("summarize");
    worker.wake();
    await worker.idle();
    expect(await getJob(db, owner.id, decemberJob.job.id)).toMatchObject({ status: "queued", attempts: 0 });
    clock.advance(DECEMBER - clock.now());
    await expect.poll(async () => (await getJob(db, owner.id, decemberJob.job.id)).status).toBe("succeeded");
    expect(await json(call("GET", "/v1/usage"))).toMatchObject({ month: "2026-12", total_cost_usd: 0, warning_80: false, exceeded_100: false });
    expect(events.filter((e) => e.event === "notification")).toHaveLength(2);
  } finally {
    await stop();
    await worker.stop();
    await scheduler.stop();
    await runtime.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
