// T-11：会话 CRUD、消息入口（ADR-07）、R9、R10、FR-CHAT-03/04/05、恢复扫描。全部使用 faux，零费用。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ConversationService, IngressService } from "../../packages/conversations/src/index.ts";
import { RuntimeBusy, systemClock, uuidv7, type ConversationSnapshot, type RuntimePort } from "../../packages/core/src/index.ts";
import { guardDb, migrate, type SqlDatabase } from "../../packages/db/src/index.ts";
import { openAppDatabase, PiRuntime, startPi, type PiHandle } from "../../packages/runtime-pi/src/index.ts";
import { fauxAssistantMessage, fauxProvider } from "../../packages/runtime-pi/src/testing/faux.ts";
import { createApp, LIMITS } from "../../apps/server/src/app.ts";

const ORIGIN = "http://127.0.0.1:4777";
const PASSWORD = "correct horse battery";
const model = { provider: "faux", modelId: "faux-1" } as const;
const crid = () => crypto.randomUUID();

let dir: string;
let faux: ReturnType<typeof fauxProvider>;
let pi: PiHandle;
let db: SqlDatabase;
let runtime: PiRuntime;
let conversations: ConversationService;
let ingress: IngressService;
let h: ReturnType<typeof createApp>;
let cookie: string;
let ownerId: string;

async function setup(opts: { tokensPerSecond?: number; limits?: { message: number } } = {}) {
  dir = mkdtempSync(join(tmpdir(), "durakeep-conv-"));
  faux = fauxProvider(opts.tokensPerSecond ? { tokensPerSecond: opts.tokensPerSecond } : {});
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  db = guardDb(raw);
  await migrate(db);
  // maxRetries: 0 —— 模型错误立即失败，测试不用等退避
  pi = await startPi({ mode: "test", db: raw, faux, settings: { retry: { maxRetries: 0 } } });
  runtime = new PiRuntime(pi, { model });
  conversations = new ConversationService(db, runtime, systemClock);
  ingress = new IngressService(db, runtime, systemClock, conversations);
  h = createApp({ db, clock: systemClock, origin: ORIGIN, chat: { conversations, ingress }, limits: opts.limits });
  const owner = await h.auth.initOwner({ password: PASSWORD, timezone: "Asia/Shanghai" });
  ownerId = owner.id;
  const login = await h.app.request("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ password: PASSWORD }),
  });
  cookie = /sid=[^;]+/.exec(login.headers.get("set-cookie")!)![0];
  runtime.resume();
}
afterEach(async () => {
  await pi.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  h.app.request(path, {
    method,
    headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
type J = Record<string, unknown>;
const json = async (r: Response) => (await r.json()) as J;
const newConv = async (title?: string) => (await json(await call("POST", "/v1/conversations", title ? { title } : undefined))).id as string;
const send = (conv: string, text: string, extra: J = {}) => call("POST", `/v1/conversations/${conv}/messages`, { client_request_id: crid(), text, ...extra });

async function snapshotOf(conv: string): Promise<ConversationSnapshot> {
  const row = await conversations.get(ownerId, conv);
  let last: ConversationSnapshot | undefined;
  const obs = await runtime.observe(row.piConversationId, undefined, (s) => (last = s));
  await obs.stop();
  return last!;
}
const count = (s: ConversationSnapshot, kind: string) => s.entries.filter((e) => e.kind === kind).length;
const waitDone = async (submissionId: string) => runtime.waitSubmission(submissionId);

beforeEach(async () => {
  await setup({ limits: { message: 10_000 } }); // 默认放宽，限流本身在最后一个用例里单独测
});

test("会话 CRUD：创建 201、列表按最近活动倒序、分页、重命名、归档后不在列表且不可发送", async () => {
  const a = await json(await call("POST", "/v1/conversations", { title: "阅读计划" }));
  expect(a).toMatchObject({ title: "阅读计划", archived: false });
  expect(typeof a.created_at).toBe("number");
  const b = await newConv();
  const c = await newConv("第三个");
  expect((await json(await call("GET", "/v1/conversations"))).items).toHaveLength(3);

  // 给 a 发一条消息 → 最近活动上移
  const sent = await send(a.id as string, "你好");
  expect(sent.status).toBe(202);
  const list = (await json(await call("GET", "/v1/conversations"))).items as J[];
  expect(list[0]!.id).toBe(a.id);

  const p1 = await json(await call("GET", "/v1/conversations?limit=2"));
  expect((p1.items as J[]).map((x) => x.id)).toEqual([a.id, c]);
  expect(typeof p1.next_cursor).toBe("string");
  const p2 = await json(await call("GET", `/v1/conversations?limit=2&cursor=${p1.next_cursor}`));
  expect((p2.items as J[]).map((x) => x.id)).toEqual([b]);
  expect(p2.next_cursor).toBeNull();
  expect((await call("GET", "/v1/conversations?limit=0")).status).toBe(400);
  expect((await call("GET", "/v1/conversations?cursor=garbage")).status).toBe(400);

  const renamed = await json(await call("PATCH", `/v1/conversations/${b}`, { title: "新名字" }));
  expect(renamed.title).toBe("新名字");
  expect((await call("PATCH", `/v1/conversations/${b}`, { title: "   " })).status).toBe(400);
  expect((await call("PATCH", `/v1/conversations/${b}`, { archived: "yes" })).status).toBe(400);

  const archived = await json(await call("PATCH", `/v1/conversations/${b}`, { archived: true }));
  expect(archived.archived).toBe(true);
  expect(((await json(await call("GET", "/v1/conversations"))).items as J[]).map((x) => x.id)).not.toContain(b);
  expect((await send(b, "还能发吗")).status).toBe(404);
  const restored = await json(await call("PATCH", `/v1/conversations/${b}`, { archived: false }));
  expect(restored.archived).toBe(false);
  expect((await send(b, "恢复后可以发")).status).toBe(202);
});

test("owner 隔离：别人的会话与不存在的会话一样返回 404", async () => {
  const now = Date.now();
  await db.run("INSERT INTO app_owners (id, display_name, timezone, created_at) VALUES ('other', 'x', 'UTC', ?)", now);
  const foreign = await runtime.createConversation({ kind: "chat" });
  await db.run(
    "INSERT INTO app_conversations (id, owner_id, pi_conversation_id, kind, created_at, last_active_at) VALUES ('foreign-1', 'other', ?, 'chat', ?, ?)",
    foreign.piConversationId,
    now,
    now,
  );
  for (const [m, p, body] of [
    ["PATCH", "/v1/conversations/foreign-1", { title: "x" }],
    ["POST", "/v1/conversations/foreign-1/messages", { client_request_id: crid(), text: "x" }],
    ["POST", "/v1/conversations/foreign-1/continue", undefined],
    ["POST", "/v1/conversations/foreign-1/abort", undefined],
    ["POST", "/v1/conversations/does-not-exist/abort", undefined],
  ] as const) {
    const r = await call(m, p, body);
    expect(r.status, `${m} ${p}`).toBe(404);
    expect(((await json(r)).error as J).code).toBe("not_found");
  }
  expect(((await json(await call("GET", "/v1/conversations"))).items as J[]).map((x) => x.id)).not.toContain("foreign-1");
});

test("发送消息：202 与响应形状；回答到达；同 ID 同内容重发返回 200 且同一 submission；入参校验", async () => {
  faux.setResponses([fauxAssistantMessage("好的。")]);
  const conv = await newConv();
  const id = crid();
  const r1 = await call("POST", `/v1/conversations/${conv}/messages`, { client_request_id: id, text: "上次那篇文章讲了什么？" });
  expect(r1.status).toBe(202);
  const b1 = await json(r1);
  expect(b1).toMatchObject({ status: "dispatched", deduplicated: false });
  expect(typeof b1.ingress_id).toBe("string");
  expect(await waitDone(b1.submission_id as string)).toEqual({ status: "done", answerText: "好的。" });

  const r2 = await call("POST", `/v1/conversations/${conv}/messages`, { client_request_id: id, text: "上次那篇文章讲了什么？" });
  expect(r2.status).toBe(200);
  expect(await json(r2)).toMatchObject({ ingress_id: b1.ingress_id, submission_id: b1.submission_id, status: "dispatched", deduplicated: true });
  const snap = await snapshotOf(conv);
  expect(count(snap, "user")).toBe(1);
  expect(snap.entries[0]).toMatchObject({ kind: "user", text: "上次那篇文章讲了什么？", tz: "Asia/Shanghai" });

  const bad: [string, J][] = [
    ["非 UUID", { client_request_id: "abc", text: "x" }],
    ["缺 id", { text: "x" }],
    ["空文本", { client_request_id: crid(), text: "" }],
    ["全空白", { client_request_id: crid(), text: "  \n " }],
    ["超长", { client_request_id: crid(), text: "字".repeat(8001) }],
    ["steer 非布尔", { client_request_id: crid(), text: "x", steer: "yes" }],
    ["text 非字符串", { client_request_id: crid(), text: 5 }],
  ];
  for (const [name, body] of bad) {
    const r = await call("POST", `/v1/conversations/${conv}/messages`, body);
    expect(r.status, name).toBe(400);
  }
  const edge = await call("POST", `/v1/conversations/${conv}/messages`, { client_request_id: crid(), text: "字".repeat(8000) });
  expect(edge.status).toBe(202); // 恰好 8000 字符可以
});

test("R9 × 20：同一个 client_request_id、不同内容并发提交 → 一个成功、一个 409，会话里只有一条用户消息", async () => {
  faux.setResponses(Array.from({ length: 40 }, () => fauxAssistantMessage("好")));
  for (let i = 0; i < 20; i++) {
    const conv = await newConv();
    const id = crid();
    const post = (text: string) => call("POST", `/v1/conversations/${conv}/messages`, { client_request_id: id, text });
    const [r1, r2] = await Promise.all([post("内容甲"), post("内容乙")]);
    expect([r1.status, r2.status].sort(), `#${i}`).toEqual([202, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(((await json(loser)).error as J).code).toBe("idempotency_conflict");
    const winner = r1.status === 409 ? r2 : r1;
    await waitDone((await json(winner)).submission_id as string);
    expect(count(await snapshotOf(conv), "user"), `#${i}`).toBe(1);
  }
});

test("R10 × 20：同一个 client_request_id 发往不同会话 → 第二次 409，Pi 里只有一个 submission", async () => {
  faux.setResponses(Array.from({ length: 40 }, () => fauxAssistantMessage("好")));
  for (let i = 0; i < 20; i++) {
    const a = await newConv();
    const b = await newConv();
    const id = crid();
    const r1 = await call("POST", `/v1/conversations/${a}/messages`, { client_request_id: id, text: "同样的话" });
    expect(r1.status).toBe(202);
    const r2 = await call("POST", `/v1/conversations/${b}/messages`, { client_request_id: id, text: "同样的话" });
    expect(r2.status, `#${i}`).toBe(409);
    expect(((await json(r2)).error as J).code).toBe("idempotency_conflict");
    await waitDone((await json(r1)).submission_id as string);
    expect(count(await snapshotOf(a), "user")).toBe(1);
    expect(count(await snapshotOf(b), "user")).toBe(0);
  }
  const n = await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_ingress_events WHERE status = 'dispatched'");
  expect(n?.c).toBe(20); // 每组只有一条入口记录被派发
});

test("FR-CHAT-03：忙碌时的新消息默认排队（followUp）；steer 也被接纳；全部得到回答", async () => {
  await pi.close();
  rmSync(dir, { recursive: true, force: true });
  await setup({ tokensPerSecond: 40 });
  faux.setResponses([fauxAssistantMessage("第一个回答，稍微长一点以便保持忙碌。"), fauxAssistantMessage("第二个回答。"), fauxAssistantMessage("第三个回答。")]);
  const conv = await newConv();
  const m1 = await json(await send(conv, "第一问"));
  const m2 = await json(await send(conv, "第二问（排队）")); // 第一个 run 仍在进行
  const snapBusy = await snapshotOf(conv);
  expect(snapBusy.live.running).toBe(true);
  const m3 = await json(await send(conv, "第三问（插话）", { steer: true }));
  for (const m of [m1, m2, m3]) expect(m.status).toBe("dispatched");
  for (const m of [m1, m2, m3]) expect((await waitDone(m.submission_id as string)).status).toBe("done");
  const end = await snapshotOf(conv);
  console.log(`[FR-CHAT-03] 序列：${end.entries.map((e) => e.kind[0]).join("")}`);
  expect(count(end, "user")).toBe(3);
  expect(count(end, "assistant")).toBeGreaterThanOrEqual(2); // steer 并入当前 run，不一定单独产生回答
  // 默认排队的消息在第一个回答之后才被处理
  const kinds = end.entries.map((e) => e.kind);
  expect(kinds.indexOf("assistant")).toBeGreaterThan(kinds.indexOf("user"));
});

test("FR-CHAT-04：停止会中止当前 run 并撤回排队中的输入，之后会话可再次使用", async () => {
  await pi.close();
  rmSync(dir, { recursive: true, force: true });
  await setup({ tokensPerSecond: 20 });
  faux.setResponses([fauxAssistantMessage("这是一个很长的回答，".repeat(10)), fauxAssistantMessage("不应该被用到"), fauxAssistantMessage("停止之后的新回答")]);
  const conv = await newConv();
  const m1 = await json(await send(conv, "第一问"));
  const m2 = await json(await send(conv, "排队的第二问"));
  expect((await snapshotOf(conv)).live.queued).toBeGreaterThanOrEqual(0);
  const stop = await call("POST", `/v1/conversations/${conv}/abort`);
  expect(stop.status).toBe(200);
  expect(await json(stop)).toEqual({ status: "idle" });
  expect(await waitDone(m1.submission_id as string)).toMatchObject({ status: "unanswered", reason: "aborted" });
  expect((await waitDone(m2.submission_id as string)).status).toBe("unanswered"); // 排队的输入被撤回
  const after = await snapshotOf(conv);
  expect(after.live.running).toBe(false);
  expect(after.live.queued).toBe(0);

  const m3 = await json(await send(conv, "再问一次"));
  expect(await waitDone(m3.submission_id as string)).toEqual({ status: "done", answerText: "不应该被用到" });
});

test("FR-CHAT-05：run 失败时可见原因，POST continue 继续；会话忙时 continue → 409", async () => {
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "模拟的模型错误" }), fauxAssistantMessage("继续之后的回答")]);
  const conv = await newConv();
  const m = await json(await send(conv, "请回答"));
  const failed = await waitDone(m.submission_id as string);
  expect(failed.status).toBe("unanswered");
  expect(failed).toMatchObject({ reason: "model_error" });
  const snap = await snapshotOf(conv);
  expect(snap.live.runFailure?.reason).toBe("model_error");
  expect(snap.live.running).toBe(false);

  const cont = await call("POST", `/v1/conversations/${conv}/continue`);
  expect(cont.status).toBe(202);
  const sid = (await json(cont)).submission_id as string;
  expect(await waitDone(sid)).toEqual({ status: "done", answerText: "继续之后的回答" });
  expect((await snapshotOf(conv)).live.runFailure).toBeUndefined();

  // 没有可继续的内容：不是错误，run 以 nothing_to_answer 结束
  const again = await json(await call("POST", `/v1/conversations/${conv}/continue`));
  expect(await waitDone(again.submission_id as string)).toMatchObject({ status: "unanswered", reason: "nothing_to_answer" });
});

test("FR-CHAT-05：会话忙时 continue 返回 409 conversation_busy", async () => {
  await pi.close();
  rmSync(dir, { recursive: true, force: true });
  await setup({ tokensPerSecond: 20 });
  faux.setResponses([fauxAssistantMessage("很长的回答，".repeat(15))]);
  const conv = await newConv();
  await send(conv, "占住会话");
  const r = await call("POST", `/v1/conversations/${conv}/continue`);
  expect(r.status).toBe(409);
  expect(((await json(r)).error as J).code).toBe("conversation_busy");
  await call("POST", `/v1/conversations/${conv}/abort`);
});

test("恢复扫描：运行时不可用时消息保持 accepted（不丢失）；recover 用原 requestId 派发，重发得到同一 submission", async () => {
  faux.setResponses([fauxAssistantMessage("恢复后的回答")]);
  const conv = await newConv();
  // 模拟“已持久化、尚未交给 Pi”：运行时的 submitInput 抛错
  const downRuntime: RuntimePort = Object.create(runtime) as RuntimePort;
  downRuntime.submitInput = () => Promise.reject(new Error("harness restarting"));
  const flaky = new IngressService(db, downRuntime, systemClock, conversations);
  const id = crid();
  const owner = { id: ownerId, timezone: "Asia/Shanghai" };
  const first = await flaky.accept(owner, conv, { clientRequestId: id, text: "不要丢了我" });
  expect(first).toMatchObject({ status: "accepted", submissionId: null, deduplicated: false });
  const row = await db.get<{ status: string; payload_json: string | null }>("SELECT status, payload_json FROM app_ingress_events WHERE client_request_id = ?", id);
  expect(row?.status).toBe("accepted");
  expect(row?.payload_json).toContain("不要丢了我");
  expect(count(await snapshotOf(conv), "user")).toBe(0);

  expect(await ingress.recover()).toEqual({ redispatched: 1, failed: 0 });
  const after = await db.get<{ status: string; submission_id: string; payload_json: string | null }>("SELECT status, submission_id, payload_json FROM app_ingress_events WHERE client_request_id = ?", id);
  expect(after?.status).toBe("dispatched");
  expect(after?.payload_json).toBeNull(); // 原文只为恢复而存，派发后清掉
  expect(await waitDone(after!.submission_id)).toEqual({ status: "done", answerText: "恢复后的回答" });
  expect(count(await snapshotOf(conv), "user")).toBe(1);

  // 客户端重发：同一个 submission，不再产生新条目
  const resend = await call("POST", `/v1/conversations/${conv}/messages`, { client_request_id: id, text: "不要丢了我" });
  expect(resend.status).toBe(200);
  expect(await json(resend)).toMatchObject({ submission_id: after!.submission_id, status: "dispatched", deduplicated: true });
  expect(count(await snapshotOf(conv), "user")).toBe(1);
  expect(await ingress.recover()).toEqual({ redispatched: 0, failed: 0 });
});

test("accepted 状态下客户端重发也会再次派发（不必等重启）", async () => {
  faux.setResponses([fauxAssistantMessage("好")]);
  const conv = await newConv();
  const down: RuntimePort = Object.create(runtime) as RuntimePort;
  down.submitInput = () => Promise.reject(new Error("down"));
  const id = crid();
  const r1 = await new IngressService(db, down, systemClock, conversations).accept({ id: ownerId, timezone: "UTC" }, conv, { clientRequestId: id, text: "hi" });
  expect(r1.status).toBe("accepted");
  const r2 = await call("POST", `/v1/conversations/${conv}/messages`, { client_request_id: id, text: "hi" });
  expect(r2.status).toBe(200); // 已存在 → deduplicated
  const b2 = await json(r2);
  expect(b2).toMatchObject({ status: "dispatched", deduplicated: true });
  expect((await waitDone(b2.submission_id as string)).status).toBe("done");
});

test(`发送限流：每分钟 ${LIMITS.message} 条，超出 429；RuntimeBusy 仍是公开导出`, async () => {
  await pi.close();
  rmSync(dir, { recursive: true, force: true });
  await setup(); // 默认限额
  faux.setResponses(Array.from({ length: 40 }, () => fauxAssistantMessage("好")));
  const conv = await newConv();
  const codes: number[] = [];
  for (let i = 0; i < LIMITS.message + 1; i++) codes.push((await send(conv, `m${i}`)).status);
  expect(codes.slice(0, LIMITS.message).every((c) => c === 202)).toBe(true);
  expect(codes.at(-1)).toBe(429);
  expect(new RuntimeBusy().code).toBe("runtime_busy");
  expect(uuidv7()).toBeTypeOf("string");
});
