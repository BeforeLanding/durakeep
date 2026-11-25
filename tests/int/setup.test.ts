// 首次设置（网页）：只在没有 owner 时可用；需要终端里打印的设置码；成功后签发会话并通知主进程继续启动。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeClock } from "../../packages/core/src/index.ts";
import { guardDb, migrate, type SqlDatabase } from "../../packages/db/src/index.ts";
import { openAppDatabase } from "../../packages/runtime-pi/src/index.ts";
import { createApp } from "../../apps/server/src/app.ts";
import { createSetupApp, newSetupCode } from "../../apps/server/src/setup.ts";

const ORIGIN = "http://127.0.0.1:4777";
let dir: string;
let db: SqlDatabase;
let closeDb: () => Promise<void>;
const clock = new FakeClock();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "durakeep-setup-"));
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  closeDb = () => raw.close();
  db = guardDb(raw);
  await migrate(db);
});
afterEach(async () => {
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const post = (app: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, body: unknown, origin = ORIGIN) =>
  app.request("/v1/auth/setup", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });

test("设置码格式：8 位、去掉易混淆字符", () => {
  for (let i = 0; i < 50; i++) expect(newSetupCode()).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
});

test("设置码错误被拒；正确设置码（大小写、分隔符宽松）创建 owner、签发会话、只能设置一次", async () => {
  let done = 0;
  const app = createSetupApp({ db, clock, origin: ORIGIN, code: "ABCD-EFGH" }, () => done++);
  expect(await (await app.request("/v1/auth/status")).json()).toEqual({ initialized: false, setup_pending: true });
  expect((await app.request("/v1/conversations")).status).toBe(503);

  const wrong = await post(app, { setup_code: "ABCD-EFGX", password: "a good passphrase" });
  expect(wrong.status).toBe(401);
  expect((await post(app, { setup_code: "abcdefgh", password: "a good passphrase" }, "http://evil.example")).status).toBe(403);
  const weak = await post(app, { setup_code: "abcd efgh", password: "11111111" });
  expect(weak.status).toBe(400);
  expect(await db.all("SELECT id FROM app_owners")).toHaveLength(0);

  const ok = await post(app, { setup_code: "abcd efgh", password: "a good passphrase", display_name: "小明", timezone: "Asia/Tokyo" });
  expect(ok.status).toBe(204);
  const cookie = /sid=[^;]+/.exec(ok.headers.get("set-cookie") ?? "")?.[0];
  expect(cookie).toBeTruthy();
  await new Promise((r) => setTimeout(r, 80));
  expect(done).toBe(1);
  expect((await post(app, { setup_code: "ABCD-EFGH", password: "another passphrase" })).status).toBe(409);

  // 完整服务认得设置时签发的会话
  const full = createApp({ db, clock, origin: ORIGIN });
  const me = await full.app.request("/v1/me", { headers: { Cookie: cookie! } });
  expect(await me.json()).toMatchObject({ display_name: "小明", timezone: "Asia/Tokyo" });
});

test("设置码连续错误 10 次后锁定，需重启获取新码", async () => {
  const app = createSetupApp({ db, clock, origin: ORIGIN, code: "ABCD-EFGH" }, () => {});
  for (let i = 0; i < 10; i++) expect((await post(app, { setup_code: "ZZZZ-ZZZZ", password: "a good passphrase" })).status).toBe(401);
  expect((await post(app, { setup_code: "ABCD-EFGH", password: "a good passphrase" })).status).toBe(423);
});
