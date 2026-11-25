// 资料页全文搜索（GET /v1/search）与重新抓取（POST /v1/documents/:id/refresh）。
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeClock } from "../../packages/core/src/index.ts";
import { guardDb, migrate, type SqlDatabase } from "../../packages/db/src/index.ts";
import { JobWorker } from "../../packages/jobs/src/index.ts";
import { BlobStore, createChunkIndexer, excerpt, KnowledgeRetrieval, KnowledgeService } from "../../packages/knowledge/src/index.ts";
import { openAppDatabase } from "../../packages/runtime-pi/src/index.ts";
import { createApp } from "../../apps/server/src/app.ts";

const ORIGIN = "http://127.0.0.1:4777";
const PASSWORD = "correct horse battery";
let dir: string;
let db: SqlDatabase;
let closeDb: () => Promise<void>;
let clock: FakeClock;
let worker: JobWorker;
let h: ReturnType<typeof createApp>;
let cookie: string;
let server: Server | undefined;
let page = "";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "durakeep-search-"));
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  closeDb = () => raw.close();
  db = guardDb(raw);
  await migrate(db);
  clock = new FakeClock(Date.UTC(2026, 10, 25, 3, 0));
  const policy = { isPublicIp: (ip: string) => ip === "127.0.0.1", resolve: async () => ["127.0.0.1"] };
  const knowledge = new KnowledgeService({ db, blobs: new BlobStore(join(dir, "blobs")), clock, fetchPolicy: policy, indexer: createChunkIndexer(db), wake: () => worker?.wake() });
  worker = new JobWorker(db, clock, knowledge.handlers(), { onFinished: (j) => knowledge.onJobFinished(j), backoffMs: () => 30_000 });
  worker.start();
  h = createApp({ db, clock, origin: ORIGIN, knowledge, retrieval: new KnowledgeRetrieval(db), wakeJobs: () => worker.wake(), limits: { login: 10_000 } });
  await h.auth.initOwner({ password: PASSWORD, timezone: "Asia/Shanghai" });
  const login = await h.app.request("/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = /sid=[^;]+/.exec(login.headers.get("set-cookie")!)![0];
});
afterEach(async () => {
  await worker.stop();
  if (server) await new Promise<void>((r) => { server!.closeAllConnections(); server!.close(() => r()); });
  server = undefined;
  await closeDb();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const call = (method: string, path: string, body?: unknown) =>
  h.app.request(path, { method, headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
type J = Record<string, unknown>;
const json = async (r: Response) => (await r.json()) as J;

test("全文搜索：命中正文返回标题、位置和以关键词为中心的摘录；停用的资料不出现；参数校验", async () => {
  const filler = "这是一段无关的铺垫文字，用来把正文撑长。".repeat(12);
  const capture = (title: string, text: string) => call("POST", "/v1/documents", { client_request_id: crypto.randomUUID(), type: "markdown", title, text });
  const a = await json(await capture("咖啡笔记", `# 咖啡笔记\n\n## 手冲参数\n\n${filler}粉水比约 1:15，水温 92 度，总时长两分半。${filler}`));
  await capture("周会记录", "# 周会\n\n前端首版本周内交付评审。");
  await worker.idle();

  const r = await json(await call("GET", "/v1/search?q=" + encodeURIComponent("水温")));
  const items = r.items as J[];
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ document_id: a.document_id, title: "咖啡笔记", source_type: "markdown" });
  expect(String(items[0]!.loc)).toContain("手冲参数");
  expect(String(items[0]!.snippet)).toContain("水温 92 度");
  expect(String(items[0]!.snippet).startsWith("…")).toBe(true);

  await call("POST", `/v1/documents/${a.document_id}/revoke`);
  expect(((await json(await call("GET", "/v1/search?q=" + encodeURIComponent("水温")))).items as J[])).toHaveLength(0);

  expect((await call("GET", "/v1/search?q=")).status).toBe(400);
  expect((await call("GET", "/v1/search?q=" + "长".repeat(201))).status).toBe(400);
  expect((await call("GET", "/v1/search?q=a&top_k=99")).status).toBe(400);
});

test("摘录：短文原样返回；找不到关键词时取开头", () => {
  expect(excerpt("短文", "短")).toBe("短文");
  const long = "甲".repeat(300);
  expect(excerpt(long, "乙")).toBe("甲".repeat(160) + "…");
});

test("重新抓取：内容变化产生新版本、未变不产生；排队中重复请求返回同一作业；文本资料不允许", async () => {
  server = createServer((req, res) => {
    if (req.url === "/robots.txt") return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const url = `http://site.test:${(server.address() as AddressInfo).port}/post`;
  const body = (v: string) => `<html><head><title>更新日志</title></head><body><article><h1>更新日志</h1><p>${"这是一段足够长的正文，用来通过正文抽取的长度门槛。".repeat(6)}${v}</p></article></body></html>`;

  page = body("第一版");
  const r = await json(await call("POST", "/v1/documents", { client_request_id: crypto.randomUUID(), type: "url", url }));
  const id = r.document_id as string;
  await worker.idle();
  const versions = async () => ((await json(await call("GET", `/v1/documents/${id}`))).versions as J[]);
  expect(await versions()).toHaveLength(1);

  // 内容未变：作业成功但没有新版本
  const same = await call("POST", `/v1/documents/${id}/refresh`);
  expect(same.status).toBe(202);
  await worker.idle();
  expect(await versions()).toHaveLength(1);

  // 内容变化：新版本成为当前版本，旧版本保留
  page = body("第二版");
  clock.advance(1000);
  await worker.stop();
  const first = await json(await call("POST", `/v1/documents/${id}/refresh`));
  const again = await call("POST", `/v1/documents/${id}/refresh`);
  expect(again.status).toBe(200);
  expect((await json(again)).job_id).toBe(first.job_id);
  worker.start();
  await worker.idle();
  const vs = await versions();
  expect(vs).toHaveLength(2);
  const cur = vs.find((v) => v.current)!;
  expect(await (await call("GET", `/v1/documents/${id}/versions/${cur.id}/text`)).text()).toContain("第二版");

  const t = await json(await call("POST", "/v1/documents", { client_request_id: crypto.randomUUID(), type: "text", text: "一段文本" }));
  expect((await call("POST", `/v1/documents/${t.document_id}/refresh`)).status).toBe(409);
  expect((await call("POST", `/v1/documents/00000000-0000-7000-8000-000000000000/refresh`)).status).toBe(404);
});
