// 作业框架：入队去重、领取、重试与退避、永久失败、checkpoint 续跑、并发上限、取消、手动重试、恢复。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AppError, FakeClock, type Json } from "../../packages/core/src/index.ts";
import { guardDb, migrate, type SqlDatabase } from "../../packages/db/src/index.ts";
import { cancelJob, enqueue, getJob, JobError, JobWorker, listJobs, retryJob, type JobHandler, type JobRow } from "../../packages/jobs/src/index.ts";
import { openAppDatabase } from "../../packages/runtime-pi/src/index.ts";

let dir: string;
let db: SqlDatabase;
let closeDb: () => Promise<void>;
let clock: FakeClock;
const OWNER = "o1";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "durakeep-jobs-"));
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  closeDb = () => raw.close();
  db = guardDb(raw);
  await migrate(db);
  clock = new FakeClock();
});
afterEach(async () => {
  await closeDb();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const add = (dedupeKey: string, extra: { maxAttempts?: number; input?: Json } = {}) =>
  db.transaction((tx) => enqueue(tx, clock.now(), { ownerId: OWNER, kind: "ingest_text", dedupeKey, input: extra.input ?? { n: 1 }, maxAttempts: extra.maxAttempts }));
const status = async (id: string) => (await getJob(db, OWNER, id)).status;
const worker = (handler: JobHandler, opts: ConstructorParameters<typeof JobWorker>[3] = {}) =>
  new JobWorker(db, clock, { ingest_text: handler }, opts);

test("入队：(owner, dedupe_key) 去重；其他 owner 互不影响；可在调用方事务内入队并随回滚消失", async () => {
  const a = await add("k1");
  const b = await add("k1");
  expect(a.created).toBe(true);
  expect(b.created).toBe(false);
  expect(b.job.id).toBe(a.job.id);
  const other = await db.transaction((tx) => enqueue(tx, clock.now(), { ownerId: "o2", kind: "ingest_text", dedupeKey: "k1", input: {} }));
  expect(other.created).toBe(true);
  await expect(
    db.transaction(async (tx) => {
      await enqueue(tx, clock.now(), { ownerId: OWNER, kind: "ingest_text", dedupeKey: "rolled-back", input: {} });
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  expect(await listJobs(db, OWNER)).toHaveLength(1);
  await expect(getJob(db, OWNER, "nope")).rejects.toBeInstanceOf(AppError);
});

test("成功：领取 → 执行 → succeeded；onFinished 回调；input 原样传入", async () => {
  const seen: unknown[] = [];
  const finished: JobRow[] = [];
  const w = worker(async (ctx) => void seen.push(ctx.job.input), { onFinished: (j) => void finished.push(j) });
  const { job } = await add("k", { input: { hello: "world" } });
  w.start();
  await w.idle();
  expect(await status(job.id)).toBe("succeeded");
  expect(seen).toEqual([{ hello: "world" }]);
  expect(finished.map((j) => j.status)).toEqual(["succeeded"]);
  await w.stop();
});

test("可重试的失败：按退避重新排队，到时间再执行；成功后清除错误；attempts 计数", async () => {
  let calls = 0;
  const w = worker(
    async () => {
      calls++;
      if (calls < 3) throw new JobError("fetch_failed", "网络错误", true);
    },
    { backoffMs: (n) => n * 1000 },
  );
  const { job } = await add("retry");
  w.start();
  await w.idle();
  let j = await getJob(db, OWNER, job.id);
  expect([j.status, j.attempts, j.errorCode, j.nextAttemptAt - clock.now()]).toEqual(["queued", 1, "fetch_failed", 1000]);
  clock.advance(999);
  await new Promise((r) => setTimeout(r, 50));
  expect(calls).toBe(1); // 退避期内不执行
  clock.advance(1);
  await w.idle();
  j = await getJob(db, OWNER, job.id);
  expect([j.status, j.attempts, calls]).toEqual(["queued", 2, 2]);
  clock.advance(2000);
  await w.idle();
  j = await getJob(db, OWNER, job.id);
  expect([j.status, j.attempts, j.errorCode, calls]).toEqual(["succeeded", 3, null, 3]);
  await w.stop();
});

test("达到 max_attempts 后 failed，错误码与面向用户的消息保留；不含堆栈", async () => {
  const w = worker(async () => { throw new JobError("fetch_timeout", "抓取超时", true); }, { backoffMs: () => 10 });
  const { job } = await add("max", { maxAttempts: 2 });
  w.start();
  await w.idle();
  clock.advance(10);
  await w.idle();
  const j = await getJob(db, OWNER, job.id);
  expect([j.status, j.attempts, j.errorCode, j.errorMessage]).toEqual(["failed", 2, "fetch_timeout", "抓取超时"]);
  await w.stop();
});

test("不可重试的失败（JobError retryable=false / AppError）立即 failed；普通异常按可重试处理且不泄漏细节", async () => {
  const w = worker(async (ctx) => {
    const t = (ctx.job.input as { t: string }).t;
    if (t === "ssrf") throw new JobError("ssrf_blocked", "地址不被允许", false);
    if (t === "app") throw new AppError("unsupported_type", "不支持的类型");
    throw new Error("secret stack detail /home/x");
  }, { backoffMs: () => 1_000_000 });
  const ssrf = (await add("a", { input: { t: "ssrf" } })).job;
  const app = (await add("b", { input: { t: "app" } })).job;
  const boom = (await add("c", { input: { t: "boom" } })).job;
  w.start();
  await w.idle();
  expect((await getJob(db, OWNER, ssrf.id)).status).toBe("failed");
  const a = await getJob(db, OWNER, app.id);
  expect([a.status, a.errorCode]).toEqual(["failed", "unsupported_type"]);
  const b = await getJob(db, OWNER, boom.id);
  expect([b.status, b.errorCode, b.errorMessage]).toEqual(["queued", "internal", "处理时出现内部错误"]);
  expect(JSON.stringify(b)).not.toContain("secret");
  await w.stop();
});

test("checkpoint：save 合并写入；崩溃遗留的 running 经 recover 改回 queued，重试时能读到已完成阶段", async () => {
  let first = true;
  const stages: string[] = [];
  const handler: JobHandler = async (ctx) => {
    if (ctx.checkpoint.fetched === undefined) {
      stages.push("fetch");
      await ctx.save({ fetched: "hash-1" });
    }
    if (first) {
      first = false;
      throw new JobError("fetch_failed", "模拟中途失败", true);
    }
    if (ctx.checkpoint.extracted === undefined) {
      stages.push("extract");
      await ctx.save({ extracted: "hash-2" });
    }
  };
  const w = worker(handler, { backoffMs: () => 5 });
  const { job } = await add("cp");
  w.start();
  await w.idle();
  expect((await getJob(db, OWNER, job.id)).checkpoint).toEqual({ fetched: "hash-1" });
  clock.advance(5);
  await w.idle();
  expect(stages).toEqual(["fetch", "extract"]); // 第二次没有重复 fetch
  expect((await getJob(db, OWNER, job.id)).checkpoint).toEqual({ extracted: "hash-2", fetched: "hash-1" });
  await w.stop();

  // 进程崩溃：库里留下 running
  const crashed = (await add("crash")).job;
  await db.run("UPDATE app_jobs SET status = 'running', attempts = 1, checkpoint_json = ? WHERE id = ?", JSON.stringify({ fetched: "h" }), crashed.id);
  const seen: unknown[] = [];
  const w2 = worker(async (ctx) => void seen.push({ ...ctx.checkpoint }));
  expect(await w2.recover()).toBe(1);
  w2.start();
  await w2.idle();
  expect(seen).toEqual([{ fetched: "h" }]);
  expect((await getJob(db, OWNER, crashed.id)).status).toBe("succeeded");
  await w2.stop();
});

test("并发上限：同时执行的作业不超过 concurrency；全部最终完成", async () => {
  let active = 0;
  let peak = 0;
  const w = worker(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 40));
    active--;
  }, { concurrency: 2 });
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push((await add(`c${i}`)).job.id);
  w.start();
  await w.idle();
  expect(peak).toBe(2);
  for (const id of ids) expect(await status(id)).toBe("succeeded");
  await w.stop();
});

test("取消：排队中的不会执行；运行中的在下一个 save 检查点停止，状态保持 cancelled", async () => {
  const w = worker(async (ctx) => {
    if ((ctx.job.input as { slow?: boolean }).slow) {
      await new Promise((r) => setTimeout(r, 80));
      await ctx.save({ step: 1 }); // 检查点
      throw new Error("不应到达：取消后 save 应抛 JobCancelled");
    }
  });
  const queued = (await add("q")).job;
  await cancelJob(db, clock.now(), OWNER, queued.id);
  const slow = (await add("s", { input: { slow: true } })).job;
  w.start();
  for (let i = 0; i < 100 && (await status(slow.id)) !== "running"; i++) await new Promise((r) => setTimeout(r, 10));
  await cancelJob(db, clock.now(), OWNER, slow.id);
  await w.idle();
  expect(await status(queued.id)).toBe("cancelled");
  expect(await status(slow.id)).toBe("cancelled");
  await expect(cancelJob(db, clock.now(), OWNER, slow.id)).rejects.toBeInstanceOf(AppError);
  await w.stop();
});

test("手动重试：只对 failed 有效，attempts 清零并重新排队；owner 隔离", async () => {
  let ok = false;
  const w = worker(async () => { if (!ok) throw new JobError("fetch_failed", "x", false); });
  const { job } = await add("manual");
  w.start();
  await w.idle();
  expect((await getJob(db, OWNER, job.id)).status).toBe("failed");
  await expect(retryJob(db, clock.now(), "o2", job.id)).rejects.toMatchObject({ code: "not_found" });
  ok = true;
  const re = await retryJob(db, clock.now(), OWNER, job.id);
  expect([re.status, re.attempts, re.errorCode]).toEqual(["queued", 0, null]);
  w.wake();
  await w.idle();
  expect(await status(job.id)).toBe("succeeded");
  await expect(retryJob(db, clock.now(), OWNER, job.id)).rejects.toMatchObject({ code: "invalid_request" });
  await w.stop();
});

test("stop 等待执行中的作业结束，之后不再领取新作业", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const w = worker(async (ctx) => {
    if ((ctx.job.input as { n: number }).n === 1) await gate;
  }, { concurrency: 1 });
  const a = (await add("a", { input: { n: 1 } })).job;
  w.start();
  for (let i = 0; i < 100 && (await status(a.id)) !== "running"; i++) await new Promise((r) => setTimeout(r, 10));
  const stopping = w.stop();
  const b = (await add("b", { input: { n: 2 } })).job;
  w.wake();
  release();
  await stopping;
  expect(await status(a.id)).toBe("succeeded");
  expect(await status(b.id)).toBe("queued"); // 停止后不再领取
});

test("唤醒不丢失：worker 刚启动、pump 还在收尾时入队并 wake，作业仍会被领取（回归：T-13 发现的丢失唤醒）", async () => {
  for (let i = 0; i < 25; i++) {
    const w = worker(async () => {});
    w.start(); // 启动后的第一轮 pump 此刻正在进行
    const { job } = await add(`race-${i}`);
    w.wake(); // 撞上正在进行的 pump
    await w.idle(3000);
    expect(await status(job.id), `第 ${i} 轮`).toBe("succeeded");
    await w.stop();
  }
});
