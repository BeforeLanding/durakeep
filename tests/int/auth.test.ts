// S1–S4（08 §6）与 T-10 的 HTTP 约定：错误格式、限流、cookie 属性、日志不含敏感内容。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeClock } from "../../packages/core/src/index.ts";
import { guardDb, migrate, type SqlDatabase } from "../../packages/db/src/index.ts";
import { openAppDatabase } from "../../packages/runtime-pi/src/index.ts";
import { createApp, type LogEvent } from "../../apps/server/src/app.ts";
import { listen } from "../../apps/server/src/listen.ts";
import { SESSION_TTL_MS } from "../../apps/server/src/auth.ts";

const ORIGIN = "http://127.0.0.1:4777";
const PASSWORD = "correct horse battery";
let dir: string;
let db: SqlDatabase;
let clock: FakeClock;
let logs: LogEvent[];
let h: ReturnType<typeof createApp>;
let closeDb: () => Promise<void>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "durakeep-auth-"));
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  closeDb = () => raw.close();
  db = guardDb(raw);
  await migrate(db);
  clock = new FakeClock();
  logs = [];
  h = createApp({ db, clock, origin: ORIGIN, log: (e) => logs.push(e) });
  await h.auth.initOwner({ password: PASSWORD, timezone: "Asia/Shanghai" });
});
afterEach(async () => {
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  h.app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (path: string, headers: Record<string, string> = {}) => h.app.request(path, { headers });
const sid = (res: Response) => /sid=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
async function login(password = PASSWORD) {
  const res = await post("/v1/auth/login", { password });
  return { res, token: sid(res) };
}
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; message: string; details: Record<string, unknown> } }).error;

test("S1：未登录访问所有 /v1/*（health 除外）都返回 401，错误格式统一", async () => {
  for (const [m, p] of [["GET", "/v1/me"], ["POST", "/v1/auth/logout"], ["GET", "/v1/conversations"], ["GET", "/v1/anything/else"], ["POST", "/v1/conversations"]] as const) {
    const res = m === "GET" ? await get(p) : await post(p, {});
    expect(res.status, `${m} ${p}`).toBe(401);
    const e = await errorOf(res);
    expect(e.code).toBe("unauthenticated");
    expect(typeof e.message).toBe("string");
    expect(e.details).toEqual({});
  }
  const health = await get("/v1/health");
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });
  // 伪造的 cookie 同样 401
  expect((await get("/v1/me", { Cookie: "sid=forged" })).status).toBe(401);
});

test("S2：口令错误 5 次后锁定 60 s；锁定期间正确口令也被拒；到期后恢复", async () => {
  for (let i = 1; i <= 4; i++) {
    const { res } = await login("wrong-password");
    expect(res.status, `第 ${i} 次`).toBe(401);
  }
  const fifth = await login("wrong-password");
  expect(fifth.res.status).toBe(423);
  expect((await errorOf(fifth.res)).code).toBe("locked");

  clock.advance(10_000);
  const during = await login(PASSWORD);
  expect(during.res.status).toBe(423);
  const e = await errorOf(during.res);
  expect(e.details.retry_after_ms).toBeGreaterThan(0);
  expect(e.details.retry_after_ms as number).toBeLessThanOrEqual(50_000);
  expect(during.res.headers.get("retry-after")).toBe("50");

  clock.advance(50_001);
  const after = await login(PASSWORD);
  expect(after.res.status).toBe(204);
  expect(after.token).toBeTruthy();
});

test("S2 补充：成功登录清零失败计数；登录接口限流每分钟 10 次 → 429", async () => {
  for (let i = 0; i < 4; i++) await login("wrong-password");
  expect((await login()).res.status).toBe(204); // 清零
  for (let i = 0; i < 4; i++) expect((await login("wrong-password")).res.status).toBe(401); // 若没清零，这里会提前锁定
  clock.advance(61_000);
  const codes: number[] = [];
  for (let i = 0; i < 11; i++) codes.push((await login("x")).res.status);
  expect(codes.slice(0, 10).every((c) => c === 401 || c === 423)).toBe(true); // 前 10 次进入口令校验
  expect(codes[10]).toBe(429);
  const limited = await login(PASSWORD);
  expect(limited.res.status).toBe(429);
  expect((await errorOf(limited.res)).code).toBe("rate_limited");
});

test("S3：登出、过期后旧 cookie 无效；cookie 属性正确；库里不存明文 token", async () => {
  const { res, token } = await login();
  const setCookie = res.headers.get("set-cookie")!;
  expect(setCookie).toMatch(/HttpOnly/i);
  expect(setCookie).toMatch(/SameSite=Strict/i);
  expect(setCookie).toMatch(/Path=\//);
  expect(setCookie).toMatch(new RegExp(`Max-Age=${SESSION_TTL_MS / 1000}`));
  expect(token).toBeTruthy();

  const me = await get("/v1/me", { Cookie: `sid=${token}` });
  expect(me.status).toBe(200);
  expect(await me.json()).toMatchObject({ display_name: "我", timezone: "Asia/Shanghai" });

  const rows = await db.all<{ token_hash: string }>("SELECT token_hash FROM app_sessions");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.token_hash).not.toBe(token);
  expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);

  const out = await post("/v1/auth/logout", undefined, { Cookie: `sid=${token}` });
  expect(out.status).toBe(204);
  expect(out.headers.get("set-cookie")).toMatch(/sid=;|Max-Age=0/i);
  expect((await get("/v1/me", { Cookie: `sid=${token}` })).status).toBe(401); // 旧 cookie 失效

  const again = await login();
  clock.advance(SESSION_TTL_MS - 1);
  expect((await get("/v1/me", { Cookie: `sid=${again.token}` })).status).toBe(200);
  clock.advance(2);
  expect((await get("/v1/me", { Cookie: `sid=${again.token}` })).status).toBe(401); // 14 天后过期
  expect(await db.all("SELECT 1 FROM app_sessions")).toHaveLength(0); // 过期会话被清除
});

test("S3 补充：改口令使所有会话失效", async () => {
  const { token } = await login();
  await h.auth.changePassword("a brand new password");
  expect((await get("/v1/me", { Cookie: `sid=${token}` })).status).toBe(401);
  expect((await login(PASSWORD)).res.status).toBe(401);
  expect((await login("a brand new password")).res.status).toBe(204);
});

test("S4：带外部 Origin 的修改类请求返回 403；同源与非浏览器客户端放行", async () => {
  const bad = await post("/v1/auth/login", { password: PASSWORD }, { Origin: "http://evil.example" });
  expect(bad.status).toBe(403);
  expect((await errorOf(bad)).code).toBe("origin_mismatch");
  expect(bad.headers.get("set-cookie")).toBeNull();

  // 端口或主机名不同也算外部
  for (const o of ["http://127.0.0.1:9999", "http://localhost:4777", "https://127.0.0.1:4777", "null"]) {
    expect((await post("/v1/auth/login", { password: PASSWORD }, { Origin: o })).status, o).toBe(403);
  }

  const { token } = await login();
  const cookie = { Cookie: `sid=${token}` };
  // 已登录的会话也不能被跨站请求登出
  expect((await post("/v1/auth/logout", undefined, { ...cookie, Origin: "http://evil.example" })).status).toBe(403);
  expect((await get("/v1/me", cookie)).status).toBe(200);
  // 没有 Origin：浏览器会带 Sec-Fetch-Site，跨站则拒绝；curl 等不带则放行
  const noOrigin = (extra: Record<string, string>) =>
    h.app.request("/v1/auth/logout", { method: "POST", headers: { ...cookie, ...extra } });
  expect((await noOrigin({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  expect((await get("/v1/me", cookie)).status).toBe(200);
  expect((await noOrigin({})).status).toBe(204);
});

test("请求校验与错误格式：非 JSON、缺字段 → 400；未知路径 → 404 JSON；过大请求体 → 413", async () => {
  const notJson = await h.app.request("/v1/auth/login", { method: "POST", headers: { Origin: ORIGIN }, body: "not json" });
  expect(notJson.status).toBe(400);
  expect((await errorOf(notJson)).code).toBe("invalid_request");
  const missing = await post("/v1/auth/login", {});
  expect(missing.status).toBe(400);
  expect(((await errorOf(missing)).details.issues as { path: string }[])[0]!.path).toBe("password");

  const { token } = await login();
  const nf = await get("/v1/nope", { Cookie: `sid=${token}` });
  expect(nf.status).toBe(404);
  expect((await errorOf(nf)).code).toBe("not_found");

  const big = await h.app.request("/v1/auth/login", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "Content-Length": String(2 * 1024 * 1024) },
    body: JSON.stringify({ password: "x".repeat(2 * 1024 * 1024) }),
  });
  expect(big.status).toBe(413);
  expect((await errorOf(big)).code).toBe("too_large");
});

test("日志只含方法、路径、状态与 ID：不含口令、token 或请求体（S11 的一部分）", async () => {
  const { token } = await login();
  await login("a-wrong-password-xyz");
  await get("/v1/me", { Cookie: `sid=${token}` });
  const text = JSON.stringify(logs);
  expect(logs.length).toBeGreaterThan(3);
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain("a-wrong-password-xyz");
  expect(text).not.toContain(token!);
  expect(logs.some((l) => l.event === "auth.login" && typeof l.owner_id === "string")).toBe(true);
});

test("真实监听 127.0.0.1：登录 → /v1/me → 登出 的 HTTP 往返", async () => {
  // 先监听拿到端口，再建 origin 与之一致的 app（端口由系统分配）
  let handler: (req: Request) => Response | Promise<Response> = () => new Response(null, { status: 503 });
  const srv = await listen((req) => handler(req), { host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  handler = createApp({ db, clock, origin: base }).app.fetch;
  try {
    expect(srv.host).toBe("127.0.0.1");
    const r1 = await fetch(`${base}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(r1.status).toBe(204);
    const cookie = /sid=[^;]+/.exec(r1.headers.get("set-cookie")!)![0];
    expect((await fetch(`${base}/v1/me`, { headers: { Cookie: cookie } })).status).toBe(200);
    const r3 = await fetch(`${base}/v1/auth/logout`, { method: "POST", headers: { Cookie: cookie, Origin: base } });
    expect(r3.status).toBe(204);
    expect((await fetch(`${base}/v1/me`, { headers: { Cookie: cookie } })).status).toBe(401);
  } finally {
    await srv.close();
  }
});
