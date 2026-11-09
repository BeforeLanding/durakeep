// T-18 的服务端配套：GET /v1/chunks/:id（引用悬停）与静态托管（SPA 回退、路径逃逸、安全头）。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeClock } from "../../packages/core/src/index.ts";
import { guardDb, migrate } from "../../packages/db/src/index.ts";
import { JobWorker } from "../../packages/jobs/src/index.ts";
import { BlobStore, createChunkIndexer, KnowledgeService } from "../../packages/knowledge/src/index.ts";
import { openAppDatabase } from "../../packages/runtime-pi/src/index.ts";
import { createApp } from "../../apps/server/src/app.ts";

const ORIGIN = "http://127.0.0.1:4777";
let dir: string;
let closeDb: () => Promise<void>;
let worker: JobWorker;
let h: ReturnType<typeof createApp>;
let knowledge: KnowledgeService;
let cookie: string;
let otherCookie: string;
let ownerId: string;

const login = async (password: string) => {
  const r = await h.app.request("/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ password }) });
  return /sid=[^;]+/.exec(r.headers.get("set-cookie") ?? "")?.[0] ?? "";
};
const get = (path: string, c = cookie) => h.app.request(path, { headers: { Cookie: c } });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "durakeep-web-"));
  mkdirSync(join(dir, "dist/assets"), { recursive: true });
  writeFileSync(join(dir, "dist/index.html"), "<!doctype html><title>x</title>");
  writeFileSync(join(dir, "dist/assets/a.js"), "console.log(1)");
  writeFileSync(join(dir, "secret.txt"), "不应该被读到");
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  closeDb = () => raw.close();
  const db = guardDb(raw);
  await migrate(db);
  const clock = new FakeClock(Date.UTC(2026, 10, 9, 7, 0));
  knowledge = new KnowledgeService({ db, blobs: new BlobStore(join(dir, "blobs")), clock, indexer: createChunkIndexer(db), wake: () => worker?.wake() });
  worker = new JobWorker(db, clock, knowledge.handlers(), { onFinished: (j) => knowledge.onJobFinished(j) });
  worker.start();
  h = createApp({ db, clock, origin: ORIGIN, knowledge, wakeJobs: () => worker.wake(), staticDir: join(dir, "dist"), limits: { login: 10_000 } });
  ownerId = (await h.auth.initOwner({ password: "correct horse battery", timezone: "Asia/Shanghai" })).id;
  cookie = await login("correct horse battery");
  // 第二个 owner 不存在（单用户）：用一个伪造的 sid 代表“别人”
  otherCookie = "sid=forged";
});
afterEach(async () => {
  await worker.stop();
  await closeDb();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("GET /v1/chunks/:id：返回片段文本与出处；停止使用后 404；非数字 / 不存在 404；未登录 401", async () => {
  const r = await knowledge.captureText(ownerId, { clientRequestId: crypto.randomUUID(), kind: "markdown", text: "# 标题\n\n## 方法\n间隔重复建议在即将遗忘时复习。", tags: [] });
  await worker.idle();
  const list = (await (await get("/v1/documents")).json()) as { items: { id: string }[] };
  expect(list.items[0]!.id).toBe(r.documentId);
  // 通过检索得到片段 id（与 kb_search 同一路径）
  const hit = await h.app.request("/v1/chunks/1", { headers: { Cookie: cookie } });
  expect(hit.status).toBe(200);
  const body = (await hit.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ id: 1, document_id: r.documentId, title: "标题" });
  expect(String(body.text)).toContain("间隔重复");
  expect(body.owner_id).toBeUndefined();
  expect((await get("/v1/chunks/abc")).status).toBe(404);
  expect((await get("/v1/chunks/99999")).status).toBe(404);
  expect((await get("/v1/chunks/1", otherCookie)).status).toBe(401);
  await h.app.request(`/v1/documents/${r.documentId}/revoke`, { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN } });
  expect((await get("/v1/chunks/1")).status).toBe(404);
});

test("静态托管：index.html 带 CSP；SPA 回退；缺失的资源文件 404；路径逃逸拿不到 dist 之外的文件；/v1 不被回退", async () => {
  const idx = await h.app.request("/");
  expect(idx.status).toBe(200);
  expect(idx.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(await idx.text()).toContain("<title>x</title>");
  expect((await h.app.request("/chat/abc")).status).toBe(200); // SPA 回退
  const js = await h.app.request("/assets/a.js");
  expect(js.headers.get("content-type")).toContain("javascript");
  expect((await h.app.request("/assets/missing.js")).status).toBe(404);
  for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
    const r = await h.app.request(p);
    expect(await r.text()).not.toContain("不应该被读到");
  }
  expect((await h.app.request("/v1/nope", { headers: { Cookie: cookie } })).status).toBe(404);
});
