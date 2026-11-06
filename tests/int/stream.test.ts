// T-12：会话流 / 全局流 / 条目分页。重点：断线重连只补发缺失的条目（FR-CHAT-02）。全部使用 faux。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ConversationService, IngressService } from "../../packages/conversations/src/index.ts";
import { systemClock, type RuntimePort } from "../../packages/core/src/index.ts";
import { guardDb, migrate, type SqlDatabase } from "../../packages/db/src/index.ts";
import { openAppDatabase, PiRuntime, startPi, type PiHandle } from "../../packages/runtime-pi/src/index.ts";
import { fauxAssistantMessage, fauxProvider } from "../../packages/runtime-pi/src/testing/faux.ts";
import { createApp } from "../../apps/server/src/app.ts";
import { listen } from "../../apps/server/src/listen.ts";
import { SseReader, snap } from "../support/sse.ts";

const ORIGIN = "http://127.0.0.1:4777";
const PASSWORD = "correct horse battery";
const model = { provider: "faux", modelId: "faux-1" } as const;

let dir: string;
let faux: ReturnType<typeof fauxProvider>;
let pi: PiHandle;
let db: SqlDatabase;
let runtime: PiRuntime;
let h: ReturnType<typeof createApp>;
let cookie: string;
let healthy = true;
let observing = 0; // 当前未释放的 observe 数
let counted: RuntimePort;
let conversations: ConversationService;
let ingress: IngressService;

async function setup(opts: { tokensPerSecond?: number } = {}) {
  dir = mkdtempSync(join(tmpdir(), "durakeep-sse-"));
  faux = fauxProvider(opts.tokensPerSecond ? { tokensPerSecond: opts.tokensPerSecond } : {});
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  db = guardDb(raw);
  await migrate(db);
  pi = await startPi({ mode: "test", db: raw, faux, settings: { retry: { maxRetries: 0 } } });
  runtime = new PiRuntime(pi, { model });
  // 包一层，统计 observe 的获取 / 释放（用 Proxy：PiRuntime 有私有字段，不能用 Object.create）
  observing = 0;
  counted = new Proxy(runtime, {
    get(target, prop) {
      if (prop === "observe") {
        return async (conv: string, from: string | undefined, listener: Parameters<RuntimePort["observe"]>[2]) => {
          observing++;
          const o = await target.observe(conv, from, listener);
          let stopped = false;
          return {
            cursor: () => o.cursor(),
            stop: async () => {
              if (!stopped) {
                stopped = true;
                observing--;
              }
              await o.stop();
            },
          };
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as RuntimePort;
  conversations = new ConversationService(db, runtime, systemClock);
  ingress = new IngressService(db, runtime, systemClock, conversations);
  healthy = true;
  h = createApp({
    db,
    clock: systemClock,
    origin: ORIGIN,
    isHealthy: () => healthy,
    chat: { conversations, ingress, runtime: counted },
    limits: { message: 10_000, login: 10_000 },
    sse: { keepAliveMs: 60 },
  });
  await h.auth.initOwner({ password: PASSWORD, timezone: "Asia/Shanghai" });
  const login = await h.app.request("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ password: PASSWORD }),
  });
  cookie = /sid=[^;]+/.exec(login.headers.get("set-cookie")!)![0];
  runtime.resume();
}
beforeEach(async () => {
  await setup();
});
afterEach(async () => {
  await pi.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

type J = Record<string, unknown>;
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  h.app.request(path, {
    method,
    headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as J;
const newConv = async () => (await json(await call("POST", "/v1/conversations", {}))).id as string;
const send = async (conv: string, text: string) => {
  const r = await call("POST", `/v1/conversations/${conv}/messages`, { client_request_id: crypto.randomUUID(), text });
  expect(r.status).toBe(202);
  return (await json(r)).submission_id as string;
};
const openStream = (conv: string, lastEventId?: string) =>
  call("GET", `/v1/conversations/${conv}/stream`, undefined, lastEventId !== undefined ? { "Last-Event-ID": lastEventId } : {});
const settle = (id: string) => runtime.waitSubmission(id);
const idle = (e: { data?: string }) => {
  const s = snap(e as never);
  return !s.live.running && s.entries.some((x) => x.type === "assistant");
};

test("流式推进：先收到初始快照，再看到生成中的部分文字，最后是完成；响应头正确；条目只含可展示的类型", async () => {
  await pi.close();
  rmSync(dir, { recursive: true, force: true });
  await setup({ tokensPerSecond: 25 });
  faux.setResponses([fauxAssistantMessage("间隔重复建议逐步拉长复习间隔，这是一段足够长的回答。".repeat(4))]);
  const conv = await newConv();
  const res = await openStream(conv);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
  expect(res.headers.get("cache-control")).toMatch(/no-cache/);
  const sse = new SseReader(res);
  const first = await sse.nextEvent();
  expect(first.event).toBe("snapshot");
  expect(snap(first)).toMatchObject({ entries: [], live: { running: false, queued: 0 }, hasEarlier: false });

  const t0 = Date.now();
  await send(conv, "给我讲讲间隔重复");
  const got = await sse.until((e) => e.event === "snapshot" && idle(e));
  const snaps = got.filter((e) => e.event === "snapshot").map(snap);
  const elapsed = Date.now() - t0;
  console.log(`[T-12] 一次回答共收到 ${snaps.length} 个快照，用时 ${elapsed}ms`);
  expect(snaps.some((s) => s.live.running && (s.live.partialText ?? "").length > 0)).toBe(true); // 看得到生成中的文字
  const last = snaps.at(-1)!;
  expect(last.entries.map((e) => e.type)).toEqual(["user", "assistant"]); // pi.system 不展示
  expect(last.entries[0]!.text).toBe("给我讲讲间隔重复"); // 不含时间信封
  expect(last.entries[1]!.text).toContain("间隔重复建议");
  // 节流：100 ms 一次，快照数不会超过 用时/100ms + 余量
  expect(snaps.length).toBeLessThanOrEqual(Math.ceil(elapsed / 100) + 4);
  const ids = got.filter((e) => e.id !== undefined).map((e) => Number(e.id));
  expect(ids.every((n, i) => i === 0 || n >= ids[i - 1]!)).toBe(true);
  await sse.cancel();
});

test("断线重连只补发缺失的条目（Last-Event-ID）", async () => {
  faux.setResponses(Array.from({ length: 6 }, (_, i) => fauxAssistantMessage(`回答${i + 1}`)));
  const conv = await newConv();
  const s1 = new SseReader(await openStream(conv));
  await s1.nextEvent();
  await send(conv, "第一问");
  const first = await s1.until((e) => e.event === "snapshot" && idle(e));
  const lastWithId = [...first].reverse().find((e) => e.id !== undefined)!;
  const cursor = lastWithId.id!;
  expect(snap(first.at(-1)!).entries.map((e) => e.text)).toEqual(["第一问", "回答1"]);
  await s1.cancel(); // 断线

  // 断线期间又发生了两轮对话
  for (const q of ["第二问", "第三问"]) await settle(await send(conv, q));

  const s2 = new SseReader(await openStream(conv, cursor));
  const resumed = await s2.nextEvent();
  const body = snap(resumed);
  // 只含错过的条目：没有第一轮的 "第一问" / "回答1"
  expect(body.entries.map((e) => e.text)).toEqual(["第二问", "回答2", "第三问", "回答3"]);
  expect(body.live.running).toBe(false);
  // 重连之后的新消息只带来新条目
  await send(conv, "第四问");
  const more = await s2.until((e) => e.event === "snapshot" && snap(e).entries.some((x) => x.text === "回答4") && !snap(e).live.running);
  expect(snap(more.at(-1)!).entries.map((e) => e.text)).toEqual(["第二问", "回答2", "第三问", "回答3", "第四问", "回答4"]);
  expect(snap(more.at(-1)!).entries.map((e) => e.text)).not.toContain("第一问");
  await s2.cancel();

  // 游标指向最新：重连后一个旧条目都不重发
  const newest = [...more].reverse().find((e) => e.id !== undefined)!.id!;
  const s3 = new SseReader(await openStream(conv, newest));
  expect(snap(await s3.nextEvent()).entries).toEqual([]);
  await s3.cancel();
});

test("无效或超前的 Last-Event-ID 不报错，退回最新窗口", async () => {
  faux.setResponses([fauxAssistantMessage("好")]);
  const conv = await newConv();
  await settle(await send(conv, "问"));
  for (const bad of ["abc", "-5", "1.5", "99999999"]) {
    const s = new SseReader(await openStream(conv, bad));
    const body = snap(await s.nextEvent());
    if (bad === "99999999") expect(body.entries).toEqual([]); // 超前：从空开始，等待新条目
    else expect(body.entries.map((e) => e.type)).toEqual(["user", "assistant"]);
    await s.cancel();
  }
});

test("访问控制：未登录 401；别人的或不存在的会话 404（不开流）", async () => {
  const conv = await newConv();
  const noAuth = await h.app.request(`/v1/conversations/${conv}/stream`);
  expect(noAuth.status).toBe(401);
  expect((await h.app.request("/v1/stream")).status).toBe(401);
  const missing = await openStream("nope");
  expect(missing.status).toBe(404);
  expect(missing.headers.get("content-type")).toMatch(/application\/json/);
  const now = Date.now();
  await db.run("INSERT INTO app_owners (id, display_name, timezone, created_at) VALUES ('other', 'x', 'UTC', ?)", now);
  const foreign = await runtime.createConversation({ kind: "chat" });
  await db.run(
    "INSERT INTO app_conversations (id, owner_id, pi_conversation_id, kind, created_at, last_active_at) VALUES ('foreign-1', 'other', ?, 'chat', ?, ?)",
    foreign.piConversationId,
    now,
    now,
  );
  expect((await openStream("foreign-1")).status).toBe(404);
  expect((await call("GET", "/v1/conversations/foreign-1/entries")).status).toBe(404);
  expect(observing).toBe(0);
});

test("keep-alive 注释行；客户端断开后服务端释放观察者（不泄漏）", async () => {
  const conv = await newConv();
  const s = new SseReader(await openStream(conv));
  await s.nextEvent();
  expect(observing).toBe(1);
  const ka = await s.until((e) => e.comment === "keep-alive");
  expect(ka.at(-1)!.comment).toBe("keep-alive");
  await s.cancel();
  for (let i = 0; i < 50 && observing > 0; i++) await new Promise((r) => setTimeout(r, 20));
  expect(observing).toBe(0);
  // 多个连接各自独立
  const a = new SseReader(await openStream(conv));
  const b = new SseReader(await openStream(conv));
  await a.nextEvent();
  await b.nextEvent();
  expect(observing).toBe(2);
  await a.cancel();
  for (let i = 0; i < 50 && observing > 1; i++) await new Promise((r) => setTimeout(r, 20));
  expect(observing).toBe(1);
  await b.cancel();
});

test("失败可见：run 因 model_error 结束时快照带中文原因", async () => {
  faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "上游 503" })]);
  const conv = await newConv();
  const s = new SseReader(await openStream(conv));
  await s.nextEvent();
  await send(conv, "请回答");
  const got = await s.until((e) => e.event === "snapshot" && snap(e).live.runFailure !== undefined);
  const f = snap(got.at(-1)!).live.runFailure!;
  expect(f.reason).toBe("model_error");
  expect(f.message).toContain("模型服务出错");
  await s.cancel();
});

test("条目分页：向前翻页无重复无遗漏，升序；与流里的条目一致", async () => {
  faux.setResponses(Array.from({ length: 7 }, (_, i) => fauxAssistantMessage(`答${i + 1}`)));
  const conv = await newConv();
  for (let i = 1; i <= 7; i++) await settle(await send(conv, `问${i}`));
  const all: string[] = [];
  let before: string | undefined;
  let pages = 0;
  for (;;) {
    const r = await call("GET", `/v1/conversations/${conv}/entries?limit=4${before ? `&before=${before}` : ""}`);
    expect(r.status).toBe(200);
    const page = (await json(r)) as { entries: { id: string; type: string; text: string }[]; has_earlier: boolean };
    expect(page.entries.length).toBeLessThanOrEqual(4);
    expect(page.entries.map((e) => Number(e.id))).toEqual([...page.entries.map((e) => Number(e.id))].sort((a, b) => a - b));
    all.unshift(...page.entries.map((e) => e.text));
    pages++;
    if (!page.has_earlier) break;
    before = page.entries[0]!.id;
  }
  expect(all).toEqual(Array.from({ length: 7 }, (_, i) => [`问${i + 1}`, `答${i + 1}`]).flat());
  expect(pages).toBe(4); // 14 条 / 每页 4 条
  expect((await call("GET", `/v1/conversations/${conv}/entries?limit=0`)).status).toBe(400);
  expect((await call("GET", `/v1/conversations/${conv}/entries?before=abc`)).status).toBe(400);
  const first = (await json(await call("GET", `/v1/conversations/${conv}/entries?limit=100`))) as { entries: unknown[]; has_earlier: boolean };
  expect(first.entries).toHaveLength(14);
  expect(first.has_earlier).toBe(false);
});

test("全局流：先报 runtime 状态；按 owner 投递事件；运行时失效时可见", async () => {
  const s = new SseReader(await call("GET", "/v1/stream"));
  const first = await s.nextEvent();
  expect(first.event).toBe("runtime");
  expect(JSON.parse(first.data!)).toEqual({ status: "ok" });

  const owner = (await json(await call("GET", "/v1/me"))).owner_id as string;
  h.hub.publish({ ownerId: "someone-else", event: "unread", data: { count: 99 } });
  h.hub.publish({ ownerId: owner, event: "unread", data: { count: 3 } });
  h.hub.publish({ ownerId: "*", event: "runtime", data: { status: "restarting" } });
  const a = await s.nextEvent();
  expect([a.event, JSON.parse(a.data!)]).toEqual(["unread", { count: 3 }]); // 别人的事件被过滤
  const b = await s.nextEvent();
  expect([b.event, JSON.parse(b.data!)]).toEqual(["runtime", { status: "restarting" }]);
  await s.cancel();
  for (let i = 0; i < 50 && h.hub.size > 0; i++) await new Promise((r) => setTimeout(r, 20));
  expect(h.hub.size).toBe(0);

  healthy = false;
  const s2 = new SseReader(await call("GET", "/v1/stream"));
  expect(JSON.parse((await s2.nextEvent()).data!)).toEqual({ status: "failed" });
  await s2.cancel();
});

test("真实 socket：SSE 帧格式、Last-Event-ID 续传、客户端取消后释放", async () => {
  faux.setResponses([fauxAssistantMessage("一"), fauxAssistantMessage("二")]);
  const conv = await newConv();
  await settle(await send(conv, "问一"));
  let handler: (req: Request) => Response | Promise<Response> = () => new Response(null, { status: 503 });
  const srv = await listen((req) => handler(req), { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  handler = createApp({
    db, clock: systemClock, origin: base,
    chat: { conversations, ingress, runtime: counted },
    sse: { keepAliveMs: 60 },
  }).app.fetch;
  try {
    const login = await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ password: PASSWORD }) });
    const ck = /sid=[^;]+/.exec(login.headers.get("set-cookie")!)![0];
    const ac = new AbortController();
    const res = await fetch(`${base}/v1/conversations/${conv}/stream`, { headers: { Cookie: ck }, signal: ac.signal });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const s = new SseReader(res);
    const ev = await s.nextEvent();
    expect(ev.event).toBe("snapshot");
    expect(ev.id).toMatch(/^\d+$/);
    expect(snap(ev).entries.map((e) => e.text)).toEqual(["问一", "一"]);
    expect(observing).toBe(1);
    const tAbort = Date.now();
    ac.abort();
    await s.cancel();
    for (let i = 0; i < 100 && observing > 0; i++) await new Promise((r) => setTimeout(r, 20));
    console.log(`[T-12] 真实 socket：客户端取消后观察者释放用时 ${Date.now() - tAbort}ms（keep-alive 60ms）`);
    expect(observing).toBe(0);

    await settle(await send(conv, "问二"));
    const res2 = await fetch(`${base}/v1/conversations/${conv}/stream`, { headers: { Cookie: ck, "Last-Event-ID": ev.id! } });
    const s2 = new SseReader(res2);
    expect(snap(await s2.nextEvent()).entries.map((e) => e.text)).toEqual(["问二", "二"]);
    await s2.cancel();
  } finally {
    await srv.close();
  }
});
