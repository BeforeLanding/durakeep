// T-22：提醒与调度器。FR-REM-01…04、R4（修改后旧 revision 到期不触发）、夏令时拒绝、1,000 次模拟的调度延迟 p95 ≤ 60 s。假时钟，零费用。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ConversationDirectory, ConversationService } from "../../packages/conversations/src/index.ts";
import { FakeClock } from "../../packages/core/src/index.ts";
import { guardDb, migrate, setDeliveryPaused, type SqlDatabase } from "../../packages/db/src/index.ts";
import { CATCHUP_THRESHOLD_MS, describeLocal, localToUtc, ReminderService, Scheduler, type Fired } from "../../packages/reminders/src/index.ts";
import { appCoreExtension, appGuardExtension, appRemindersExtension, context, openAppDatabase, PiRuntime, startPi, type PiHandle } from "../../packages/runtime-pi/src/index.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../../packages/runtime-pi/src/testing/faux.ts";
import { createApp } from "../../apps/server/src/app.ts";

const ORIGIN = "http://127.0.0.1:4777";
const SH = "Asia/Shanghai";
// 2026-11-06 07:00 UTC = 15:00 上海
const T0 = Date.UTC(2026, 10, 6, 7, 0);

let dir: string;
let db: SqlDatabase;
let pi: PiHandle;
let faux: ReturnType<typeof fauxProvider>;
let runtime: PiRuntime;
let clock: FakeClock;
let reminders: ReminderService;
let scheduler: Scheduler;
let fired: Fired[];
let conversations: ConversationService;
let h: ReturnType<typeof createApp>;
let cookie: string;
let ownerId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "durakeep-rem-"));
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  db = guardDb(raw);
  await migrate(db);
  clock = new FakeClock(T0);
  reminders = new ReminderService(db, clock);
  fired = [];
  scheduler = new Scheduler(db, clock, (f) => fired.push(f));
  reminders.onChange = () => scheduler.wake();
  const directory = new ConversationDirectory(db);
  faux = fauxProvider();
  pi = await startPi({
    mode: "test",
    db: raw,
    faux,
    settings: { retry: { maxRetries: 0 } },
    extensions: [appCoreExtension({ reminders: true }), appRemindersExtension({ db, conversations: directory, reminders }), appGuardExtension({ conversations: directory })],
  });
  runtime = new PiRuntime(pi, { model: { provider: "faux", modelId: "faux-1" } });
  conversations = new ConversationService(db, runtime, clock);
  runtime.resume();
  h = createApp({ db, clock, origin: ORIGIN, reminders, limits: { login: 10_000 } });
  ownerId = (await h.auth.initOwner({ password: "correct horse battery", timezone: SH })).id;
  const login = await h.app.request("/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ password: "correct horse battery" }) });
  cookie = /sid=[^;]+/.exec(login.headers.get("set-cookie")!)![0];
});
afterEach(async () => {
  await scheduler.stop();
  await pi.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const mk = (text: string, local: string, tz = SH) => reminders.create(ownerId, { text, local_datetime: local, timezone: tz });

test("恢复后暂停到期提醒，已认证的人工恢复请求立即唤醒 Scheduler 且只投递一次", async () => {
  const reminder = await mk("恢复后补发", "2026-11-06T15:05");
  await setDeliveryPaused(db, true, clock.now());
  clock.advance(6 * 60_000);
  scheduler.start();
  expect(await scheduler.tick()).toBe(0);
  expect((await reminders.get(ownerId, reminder.id)).status).toBe("active");
  expect(await reminders.notifications(ownerId)).toEqual([]);
  const health = () => h.app.request("/v1/admin/health", { headers: { Cookie: cookie } });
  expect(await (await health()).json()).toMatchObject({ delivery_paused: true });
  expect((await h.app.request("/v1/admin/delivery/resume", { method: "POST" })).status).toBe(401);
  const resumed = await h.app.request("/v1/admin/delivery/resume", { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN } });
  expect(resumed.status).toBe(200);
  expect(await resumed.json()).toEqual({ delivery_paused: false });
  await expect.poll(() => fired.length).toBe(1);
  expect(await scheduler.tick()).toBe(0);
  expect(await reminders.notifications(ownerId)).toHaveLength(1);
  expect((await reminders.list(ownerId))[0]).toMatchObject({ id: reminder.id, status: "fired", lastOccurrence: { revision: 1 } });
  expect(await (await health()).json()).toMatchObject({ delivery_paused: false });
});

// ---------------------------------------------------------------- 时间换算

test("本地时间 ⇄ UTC：上海（无夏令时）、纽约（夏令时）、回显含星期；不存在的日期、非 IANA 时区被拒绝", () => {
  expect(localToUtc("2026-11-07T20:00", SH)).toBe(Date.UTC(2026, 10, 7, 12, 0));
  expect(describeLocal(Date.UTC(2026, 10, 7, 12, 0), SH)).toBe("2026-11-07 20:00 星期六");
  expect(localToUtc("2026-07-01T09:00", "America/New_York")).toBe(Date.UTC(2026, 6, 1, 13, 0)); // EDT = UTC-4
  expect(localToUtc("2026-12-01T09:00", "America/New_York")).toBe(Date.UTC(2026, 11, 1, 14, 0)); // EST = UTC-5
  expect(localToUtc("2026-11-07T00:00", "UTC")).toBe(Date.UTC(2026, 10, 7));
  for (const bad of ["2026-02-30T10:00", "2026-13-01T10:00", "2026-11-07T24:00", "2026-11-07 20:00", "明天晚上八点", "2026-11-07T20:00:00"]) {
    expect(() => localToUtc(bad, SH), bad).toThrowError(/local_datetime|不存在/);
  }
  for (const tz of ["Mars/Base", "UTC+8", "", "+08:00", "shanghai"]) expect(() => localToUtc("2026-11-07T20:00", tz), tz).toThrow();
});

test("夏令时：跳过的本地时间（春季 02:30）与重复的本地时间（秋季 01:30）一律拒绝并说明；前后一小时正常", () => {
  expect(() => localToUtc("2026-03-08T02:30", "America/New_York")).toThrowError(/不存在/);
  expect(() => localToUtc("2026-11-01T01:30", "America/New_York")).toThrowError(/出现两次/);
  expect(localToUtc("2026-03-08T03:30", "America/New_York")).toBe(Date.UTC(2026, 2, 8, 7, 30)); // EDT
  expect(localToUtc("2026-03-08T01:30", "America/New_York")).toBe(Date.UTC(2026, 2, 8, 6, 30)); // EST
  expect(localToUtc("2026-11-01T02:30", "America/New_York")).toBe(Date.UTC(2026, 10, 1, 7, 30)); // 回拨之后 EST
  expect(localToUtc("2026-11-01T00:30", "America/New_York")).toBe(Date.UTC(2026, 10, 1, 4, 30)); // 回拨之前 EDT
  // 欧洲：春季跳过 02:30（Europe/Berlin 2026-03-29）
  expect(() => localToUtc("2026-03-29T02:30", "Europe/Berlin")).toThrowError(/不存在/);
});

// ---------------------------------------------------------------- 创建 / 回显 / 过去

test("FR-REM-01：创建 → 回显完整日期、星期、时区与 UTC，与实际触发时间一致；过去的时间拒绝（time_in_past）；关联资料必须存在", async () => {
  const r = await mk("看完《间隔重复的科学》", "2026-11-07T20:00");
  const e = reminders.echo(r);
  expect(e).toMatchObject({ local: "2026-11-07 20:00 星期六", timezone: SH, utc: "2026-11-07T12:00:00.000Z", next_fire_at: Date.UTC(2026, 10, 7, 12, 0), revision: 1, status: "active" });
  await expect(mk("过去", "2026-11-06T14:00")).rejects.toMatchObject({ code: "time_in_past" }); // 14:00 上海 = 06:00 UTC < 现在
  await expect(mk("正好现在", "2026-11-06T15:00")).rejects.toMatchObject({ code: "time_in_past" });
  await expect(reminders.create(ownerId, { text: "关联", local_datetime: "2026-11-07T20:00", timezone: SH, document_id: "nope" })).rejects.toMatchObject({ code: "not_found" });
  await expect(mk("", "2026-11-07T20:00")).rejects.toMatchObject({ code: "invalid_request" });
  // 触发时间与回显一致
  await scheduler.tick();
  clock.advance(Date.UTC(2026, 10, 7, 12, 0) - clock.now());
  await scheduler.tick();
  const occ = (await reminders.list(ownerId))[0]!.lastOccurrence!;
  expect(occ.fireAt).toBe(Date.UTC(2026, 10, 7, 12, 0));
});

// ---------------------------------------------------------------- R4 / 修改 / 取消

test("R4 / FR-REM-02：修改后 revision 加一，旧时间到期时不触发，新时间到期时触发一次；取消后到期不触发", async () => {
  const a = await mk("会改的提醒", "2026-11-06T16:00"); // 一小时后
  const b = await mk("会取消的提醒", "2026-11-06T16:30");
  const t1 = a.nextFireAt!;
  const upd = await reminders.update(ownerId, a.id, { local_datetime: "2026-11-06T18:00" }, 1);
  expect(upd).toMatchObject({ revision: 2, nextFireAt: Date.UTC(2026, 10, 6, 10, 0) });
  await expect(reminders.update(ownerId, a.id, { text: "x" }, 1)).rejects.toMatchObject({ code: "revision_conflict" });
  await reminders.cancel(ownerId, b.id);
  expect((await reminders.cancel(ownerId, b.id)).status).toBe("cancelled"); // 天然幂等
  clock.advance(t1 - clock.now() + 60_000); // 旧时间之后
  expect(await scheduler.tick()).toBe(0);
  expect(fired).toEqual([]);
  clock.advance(Date.UTC(2026, 10, 6, 10, 0) - clock.now());
  expect(await scheduler.tick()).toBe(1);
  expect(fired.map((f) => f.notification.body)).toEqual(["会改的提醒"]);
  expect(await scheduler.tick()).toBe(0); // 只触发一次
  await expect(reminders.update(ownerId, a.id, { text: "已触发" }, 2)).rejects.toMatchObject({ code: "invalid_request" });
  await expect(reminders.cancel(ownerId, a.id)).rejects.toMatchObject({ code: "invalid_request" });
});

test("修改的并发保护：tick 与修改交错时，已被改到以后的提醒不会按旧时间触发（触发事务里重读当前状态）", async () => {
  const a = await mk("竞争", "2026-11-06T16:00");
  clock.advance(a.nextFireAt! - clock.now() + 1000);
  // 到期之后、tick 之前，用户把它改到了明天
  await reminders.update(ownerId, a.id, { local_datetime: "2026-11-07T09:00" });
  expect(await scheduler.tick()).toBe(0);
  expect((await reminders.get(ownerId, a.id)).status).toBe("active");
});

// ---------------------------------------------------------------- 通知

test("FR-REM-03：到期 → 生成通知（未读）→ 标记已读 / 全部已读；未读数；在线同一个提醒只通知一次（重复 tick、occurrence 唯一）", async () => {
  await mk("甲", "2026-11-06T15:05");
  await mk("乙", "2026-11-06T15:06");
  clock.advance(10 * 60_000);
  expect(await scheduler.tick()).toBe(2);
  expect(await scheduler.tick()).toBe(0);
  expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM app_occurrences")).toEqual({ n: 2 });
  expect(await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM app_notifications")).toEqual({ n: 2 });
  expect(await reminders.unreadCount(ownerId)).toBe(2);
  const [n1] = await reminders.notifications(ownerId, { unread: true });
  await reminders.markRead(ownerId, n1!.id);
  expect(await reminders.unreadCount(ownerId)).toBe(1);
  await reminders.markAllRead(ownerId);
  expect(await reminders.unreadCount(ownerId)).toBe(0);
  expect((await reminders.notifications(ownerId, { unread: true })).length).toBe(0);
  expect((await reminders.notifications(ownerId)).length).toBe(2);
  // 唯一约束：同一个 (schedule, revision, fire_at) 不能有第二条 occurrence
  const o = (await db.get<{ schedule_id: string; revision: number; fire_at: number }>("SELECT schedule_id, revision, fire_at FROM app_occurrences LIMIT 1"))!;
  await expect(db.run("INSERT INTO app_occurrences (id, schedule_id, revision, fire_at, fired_at, late_ms) VALUES ('dup', ?, ?, ?, 0, 0)", o.schedule_id, o.revision, o.fire_at)).rejects.toThrow();
});

test("FR-REM-04：服务停止期间到期的提醒，重启后补发并标注“迟到 N 分钟”；补发与正常触发分开统计；重启不丢提醒", async () => {
  await mk("睡过头的提醒", "2026-11-06T16:00"); // T0 + 1h
  await mk("更晚的提醒", "2026-11-06T20:00"); // 还没到
  clock.advance(3 * 3600_000); // “服务停了 3 小时”：18:00 上海
  // 重启：新的 Scheduler 实例
  const s2 = new Scheduler(db, clock, (f) => fired.push(f));
  s2.start();
  await s2.tick();
  expect(fired.length).toBe(1);
  expect(fired[0]).toMatchObject({ catchup: true });
  expect(fired[0]!.notification.body).toBe("睡过头的提醒（迟到 120 分钟）");
  // 之后正常触发的提醒
  clock.advance(2 * 3600_000 + 5_000);
  await s2.tick();
  expect(fired.length).toBe(2);
  expect(fired[1]!.catchup).toBe(false);
  expect(fired[1]!.notification.body).toBe("更晚的提醒");
  expect(await s2.stats()).toMatchObject({ onTime: 1, catchup: 1 });
  await s2.stop();
});

test("调度延迟：1,000 个随机时间的提醒，按 Scheduler 自己的唤醒间隔推进假时钟，触发延迟 p95 ≤ 60 s（实际应接近 0）", async () => {
  const rnd = (() => { let x = 12345; return () => (x = (x * 1103515245 + 12345) % 2147483648) / 2147483648; })();
  await db.transaction(async (tx) => {
    for (let i = 0; i < 1000; i++) {
      const at = T0 + 60_000 + Math.floor(rnd() * 6 * 3600_000);
      const id = `s${String(i).padStart(4, "0")}`;
      await tx.run(
        "INSERT INTO app_schedules (id, owner_id, text, local_datetime, timezone, next_fire_at, revision, status, created_at, updated_at) VALUES (?, ?, ?, '2026-11-06T16:00', ?, ?, 1, 'active', ?, ?)",
        id, ownerId, `r${i}`, SH, at, T0, T0,
      );
    }
  });
  let guard = 0;
  while ((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM app_schedules WHERE status = 'active'"))!.n > 0) {
    clock.advance(await scheduler.nextDelay());
    await scheduler.tick();
    if (++guard > 5000) throw new Error("调度没有推进");
  }
  const st = await scheduler.stats();
  console.log(`[FR-REM-03] 1000 次模拟：p95 延迟 ${st.p95LateMs} ms，唤醒 ${guard} 次`);
  expect(st.onTime).toBe(1000);
  expect(st.catchup).toBe(0);
  expect(st.p95LateMs).toBeLessThanOrEqual(60_000);
  expect(fired.length).toBe(1000);
});

test("Scheduler 自己的定时器：start() 之后推进假时钟即可触发（不需要手动 tick）；最长 60 s 兜底检查", async () => {
  await mk("定时器", "2026-11-06T15:30");
  scheduler.start();
  await new Promise((r) => setTimeout(r, 30));
  for (let i = 0; i < 40 && fired.length === 0; i++) {
    clock.advance(60_000);
    await new Promise((r) => setTimeout(r, 15));
  }
  expect(fired.length).toBe(1);
  expect(fired[0]!.lateMs).toBeLessThan(CATCHUP_THRESHOLD_MS);
});

// ---------------------------------------------------------------- 接口

type J = Record<string, unknown>;
const call = (method: string, path: string, body?: unknown, ck = cookie) =>
  h.app.request(path, { method, headers: { Cookie: ck, Origin: ORIGIN, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as J;

test("接口：创建（幂等 / 422 time_in_past / 夏令时拒绝 400）→ 列表 → 修改（409）→ 取消；通知列表 / 已读 / 全部已读；未登录 401；别人的提醒 404", async () => {
  const body = { client_request_id: crypto.randomUUID(), text: "接口创建", local_datetime: "2026-11-07T20:00", timezone: SH };
  const r1 = await call("POST", "/v1/reminders", body);
  expect(r1.status).toBe(201);
  const rem = await json(r1);
  expect(rem).toMatchObject({ local: "2026-11-07 20:00 星期六", timezone: SH, next_fire_at: Date.UTC(2026, 10, 7, 12, 0), revision: 1, status: "active", last_occurrence: null });
  expect((await call("POST", "/v1/reminders", body)).status).toBe(200);
  expect((await call("POST", "/v1/reminders", { ...body, text: "不同" })).status).toBe(409);
  expect((await call("POST", "/v1/reminders", { ...body, client_request_id: crypto.randomUUID(), local_datetime: "2026-11-06T10:00" })).status).toBe(422);
  const dst = await call("POST", "/v1/reminders", { ...body, client_request_id: crypto.randomUUID(), local_datetime: "2026-03-08T02:30", timezone: "America/New_York" });
  expect([400, 422]).toContain(dst.status);
  expect((await call("POST", "/v1/reminders", { ...body, client_request_id: crypto.randomUUID(), timezone: "Mars/Base" })).status).toBe(400);
  expect(((await json(await call("GET", "/v1/reminders?status=active"))).items as J[]).length).toBe(1);
  expect((await call("GET", "/v1/reminders?status=bogus")).status).toBe(400);
  expect(await json(await call("PATCH", `/v1/reminders/${rem.id}`, { text: "改过", expected_revision: 1 }))).toMatchObject({ text: "改过", revision: 2 });
  expect((await call("PATCH", `/v1/reminders/${rem.id}`, { text: "冲突", expected_revision: 1 })).status).toBe(409);
  expect((await call("PATCH", `/v1/reminders/${rem.id}`, { text: "无版本" })).status).toBe(400);

  // 通知
  await mk("到点", "2026-11-06T15:01");
  clock.advance(90_000);
  await scheduler.tick();
  const list = await json(await call("GET", "/v1/notifications?unread=1"));
  expect(list.unread).toBe(1);
  const n = (list.items as J[])[0]!;
  expect(n).toMatchObject({ kind: "reminder", title: "提醒", body: "到点", read: false });
  expect((await call("POST", `/v1/notifications/${n.id}/read`)).status).toBe(204);
  expect((await json(await call("GET", "/v1/notifications"))).unread).toBe(0);
  expect((await call("POST", "/v1/notifications/read-all")).status).toBe(204);
  expect((await call("POST", "/v1/notifications/nope/read")).status).toBe(404);

  expect(await json(await call("POST", `/v1/reminders/${rem.id}/cancel`))).toMatchObject({ status: "cancelled" });
  expect((await h.app.request("/v1/reminders")).status).toBe(401);
  await db.run("INSERT INTO app_owners (id, display_name, timezone, created_at) VALUES ('other', 'x', 'UTC', ?)", Date.now());
  const theirs = await reminders.create("other", { text: "别人的", local_datetime: "2026-11-07T20:00", timezone: "UTC" });
  expect((await call("POST", `/v1/reminders/${theirs.id}/cancel`)).status).toBe(404);
  expect((await call("PATCH", `/v1/reminders/${theirs.id}`, { text: "x", expected_revision: 1 })).status).toBe(404);
  expect(((await json(await call("GET", "/v1/reminders"))).items as J[]).every((x) => x.text !== "别人的")).toBe(true);
});

// ---------------------------------------------------------------- 经 Pi + faux 跑通工具

type ToolResult = { name: string; text: string; isError: boolean };
async function toolResults(piConversationId: string): Promise<ToolResult[]> {
  const c = await pi.harness.conversation(Number(piConversationId) as never, context);
  const page = await c!.entries({}, 100, undefined, context);
  return [...page.items]
    .reverse()
    .filter((e) => e.kind === "pi.tool-result")
    .map((e) => {
      const m = e.model![0] as { toolName: string; isError: boolean; content: { text: string }[] };
      return { name: m.toolName, text: m.content.map((x) => x.text).join(""), isError: m.isError };
    });
}
const callTool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const ask = async (conv: { piConversationId: string }, text: string, script: Parameters<typeof faux.setResponses>[0]) => {
  faux.setResponses(script);
  const s = await runtime.submitInput(conv.piConversationId, { text, requestId: crypto.randomUUID(), steer: false, now: clock.now(), tz: SH });
  return runtime.waitSubmission(s.submissionId);
};

test("工具：reminder_create 回显完整日期 / 星期 / 时区；过去的时间 → 错误结果且不写入；update / cancel / list；夏令时拒绝；owner_id 参数被拒", async () => {
  const conv = await conversations.get(ownerId, (await conversations.create(ownerId)).id);
  await ask(conv, "明天晚上八点提醒我看完这篇文章", [callTool("reminder_create", { text: "看完这篇文章", local_datetime: "2026-11-07T20:00", timezone: SH }), fauxAssistantMessage("好的。")]);
  let res = await toolResults(conv.piConversationId);
  expect(res[0], res[0]?.text).toMatchObject({ name: "reminder_create", isError: false });
  expect(res[0]!.text).toContain("2026-11-07 20:00 星期六");
  expect(res[0]!.text).toContain("2026-11-07T12:00:00.000Z");
  const row = (await reminders.list(ownerId))[0]!;
  expect(row).toMatchObject({ text: "看完这篇文章", conversationId: conv.id });

  await ask(conv, "昨天提醒我", [callTool("reminder_create", { text: "过去", local_datetime: "2026-11-05T20:00", timezone: SH }), fauxAssistantMessage("不行。")]);
  res = await toolResults(conv.piConversationId);
  expect(res.find((r) => r.text.includes("已经过去"))?.isError).toBe(true);
  await ask(conv, "春季", [callTool("reminder_create", { text: "跳过的时间", local_datetime: "2026-03-08T02:30", timezone: "America/New_York" }), fauxAssistantMessage("换一个。")]);
  expect((await toolResults(conv.piConversationId)).some((r) => r.isError && r.text.includes("不存在"))).toBe(true);
  expect((await reminders.list(ownerId)).length).toBe(1);

  await ask(conv, "改到九点", [callTool("reminder_update", { reminder_id: row.id, local_datetime: "2026-11-07T21:00" }), fauxAssistantMessage("改好了。")]);
  expect((await reminders.get(ownerId, row.id))).toMatchObject({ revision: 2, nextFireAt: Date.UTC(2026, 10, 7, 13, 0) });
  await ask(conv, "列出", [callTool("reminder_list", {}), fauxAssistantMessage("在这里。")]);
  expect((await toolResults(conv.piConversationId)).find((r) => r.name === "reminder_list")!.text).toContain(row.id);
  await ask(conv, "取消", [callTool("reminder_cancel", { reminder_id: row.id }), callTool("reminder_cancel", { reminder_id: row.id }), fauxAssistantMessage("取消了。")]);
  expect((await reminders.get(ownerId, row.id)).status).toBe("cancelled");

  await ask(conv, "x", [callTool("reminder_create", { text: "a", local_datetime: "2026-11-07T20:00", timezone: SH, owner_id: "other" } as never), fauxAssistantMessage("好。")]);
  expect((await reminders.list(ownerId)).length).toBe(1);
});
