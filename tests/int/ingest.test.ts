// T-13：采集（文本 / Markdown / 上传 / URL）、版本、去重、失败与重试、S12。全部走 HTTP 接口，使用本机 HTTP 服务模拟网站。
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeClock } from "../../packages/core/src/index.ts";
import { guardDb, migrate, type SqlDatabase } from "../../packages/db/src/index.ts";
import { JobWorker } from "../../packages/jobs/src/index.ts";
import { BlobStore, KnowledgeService, type FetchPolicy } from "../../packages/knowledge/src/index.ts";
import { openAppDatabase } from "../../packages/runtime-pi/src/index.ts";
import { createApp } from "../../apps/server/src/app.ts";

const ORIGIN = "http://127.0.0.1:4777";
const PASSWORD = "correct horse battery";
const para = "间隔重复是一种根据遗忘曲线安排复习时间的学习方法，它的核心思想是在即将遗忘的时刻进行复习，从而用最少的复习次数获得最长的记忆保持。";
const article = (title: string, extra = "") => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title} - 某某博客</title></head>
<body><header><nav><a href="/">首页</a></nav></header><main><article><h1>${title}</h1><h2>背景</h2><p>${para}${para}</p><p>${para}${extra}</p></article></main>
<footer>© 京ICP备00000000号</footer></body></html>`;

let dir: string;
let dataDir: string;
let db: SqlDatabase;
let closeDb: () => Promise<void>;
let clock: FakeClock;
let knowledge: KnowledgeService;
let worker: JobWorker;
let h: ReturnType<typeof createApp>;
let cookie: string;
let ownerId: string;
const servers: Server[] = [];
let policy: Partial<FetchPolicy>;
let fetchLog: string[];

async function site(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const s = createServer((req, res) => {
    fetchLog.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "durakeep-ingest-"));
  dataDir = join(dir, "data");
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  closeDb = () => raw.close();
  db = guardDb(raw);
  await migrate(db);
  clock = new FakeClock(Date.UTC(2026, 10, 6, 7, 0));
  fetchLog = [];
  // 测试策略：127.0.0.1 当作公网；站点名 → 127.0.0.1
  policy = { isPublicIp: (ip) => ip === "127.0.0.1", resolve: async (host) => (host.endsWith(".test") ? ["127.0.0.1"] : Promise.reject(new Error("ENOTFOUND"))) };
  knowledge = new KnowledgeService({ db, blobs: new BlobStore(join(dataDir, "blobs")), clock, fetchPolicy: policy, wake: () => worker?.wake() });
  worker = new JobWorker(db, clock, knowledge.handlers(), { onFinished: (j) => knowledge.onJobFinished(j), backoffMs: () => 30_000 });
  worker.start();
  h = createApp({ db, clock, origin: ORIGIN, knowledge, wakeJobs: () => worker.wake(), limits: { login: 10_000 } });
  ownerId = (await h.auth.initOwner({ password: PASSWORD, timezone: "Asia/Shanghai" })).id;
  const login = await h.app.request("/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = /sid=[^;]+/.exec(login.headers.get("set-cookie")!)![0];
});
afterEach(async () => {
  await worker.stop();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  await closeDb();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

type J = Record<string, unknown>;
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  h.app.request(path, { method, headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as J;
const crid = () => crypto.randomUUID();
const capture = (body: J) => call("POST", "/v1/documents", { client_request_id: crid(), ...body });
const captureText = (text: string, extra: J = {}) => capture({ type: "text", text, ...extra });
const captureUrl = (url: string, extra: J = {}) => capture({ type: "url", url, ...extra });
const done = async () => {
  await worker.idle();
};
const detail = async (id: string) => json(await call("GET", `/v1/documents/${id}`));
const versionsOf = async (id: string) => (await detail(id)).versions as J[];

test("文本：202 → 作业完成 → ready；默认标题取首行；详情 / 正文 / 原文接口；原文以附件方式返回", async () => {
  const r = await captureText("第一行是标题\n\n正文内容在这里。", { tags: ["学习", "笔记", "学习"] });
  expect(r.status).toBe(202);
  const b = await json(r);
  expect(b).toMatchObject({ status: "pending", deduplicated: false });
  expect(typeof b.job_id).toBe("string");
  await done();
  const d = await detail(b.document_id as string);
  expect(d).toMatchObject({ source_type: "text", source_uri: null, title: "第一行是标题", status: "ready", tags: ["学习", "笔记"], error_code: null });
  const v = (d.versions as J[])[0]!;
  expect(v).toMatchObject({ status: "ready", current: true, parser_version: "text@1", char_count: 16 });
  const text = await call("GET", `/v1/documents/${b.document_id}/versions/${v.id}/text`);
  expect(text.headers.get("content-type")).toMatch(/text\/markdown/);
  expect(await text.text()).toBe("第一行是标题\n\n正文内容在这里。");
  const raw = await call("GET", `/v1/documents/${b.document_id}/versions/${v.id}/raw`);
  expect(raw.headers.get("content-disposition")).toMatch(/^attachment; filename="[\w-]+\.txt"$/);
  expect(raw.headers.get("content-security-policy")).toContain("sandbox");
  expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await raw.text()).toBe("第一行是标题\n\n正文内容在这里。");
  const job = await json(await call("GET", `/v1/jobs/${b.job_id}`));
  expect(job).toMatchObject({ kind: "ingest_text", status: "succeeded", document_id: b.document_id });
});

test("Markdown：标题取第一个 # 标题；用户标题优先；CRLF 与 BOM 被规范化而原文保持原样", async () => {
  const md = "﻿# 会议记录\r\n\r\n- 议题一\r\n- 议题二\r\n";
  const b = await json(await capture({ type: "markdown", text: md }));
  await done();
  const d = await detail(b.document_id as string);
  expect(d).toMatchObject({ source_type: "markdown", title: "会议记录", status: "ready" });
  const vid = (d.versions as J[])[0]!.id;
  expect(await (await call("GET", `/v1/documents/${b.document_id}/versions/${vid}/text`)).text()).toBe("# 会议记录\n\n- 议题一\n- 议题二");
  const raw = Buffer.from(await (await call("GET", `/v1/documents/${b.document_id}/versions/${vid}/raw`)).arrayBuffer());
  expect(raw.toString("utf8")).toBe(md);
  const titled = await json(await capture({ type: "markdown", text: "# 内部标题\n正文", title: "  我的标题  " }));
  await done();
  expect((await detail(titled.document_id as string)).title).toBe("我的标题");
});

test("请求级幂等与内容去重：同 ID 同内容 → 200 同一结果；同 ID 不同内容 → 409；不同 ID 同内容 → 去重到已有资料", async () => {
  const id = crid();
  const body = { client_request_id: id, type: "text", text: "要去重的内容" };
  const a = await call("POST", "/v1/documents", body);
  expect(a.status).toBe(202);
  const aj = await json(a);
  const b = await call("POST", "/v1/documents", body);
  expect(b.status).toBe(200);
  expect(await json(b)).toMatchObject({ document_id: aj.document_id, job_id: aj.job_id, deduplicated: true });
  const c = await call("POST", "/v1/documents", { ...body, text: "别的内容" });
  expect(c.status).toBe(409);
  expect(((await json(c)).error as J).code).toBe("idempotency_conflict");
  const d = await call("POST", "/v1/documents", { client_request_id: crid(), type: "text", text: "要去重的内容" });
  expect(d.status).toBe(200);
  expect(await json(d)).toMatchObject({ document_id: aj.document_id, job_id: null, deduplicated: true });
  await done();
  expect(((await json(await call("GET", "/v1/documents"))).items as J[]).length).toBe(1);
  // 已停止使用的资料再次收藏同样内容：仍指向原资料（不悄悄新建副本）
  await call("POST", `/v1/documents/${aj.document_id}/revoke`);
  const e = await json(await call("POST", "/v1/documents", { client_request_id: crid(), type: "text", text: "要去重的内容" }));
  expect([e.document_id, e.status, e.deduplicated]).toEqual([aj.document_id, "revoked", true]);
});

test("输入校验：空文本、超长（> 50 万字符 → 413）、非法标签、非法 type、缺少 / 非法 client_request_id", async () => {
  const bad: [string, J, number][] = [
    ["空文本", { type: "text", text: "  \n " }, 400],
    ["缺 text", { type: "text" }, 400],
    ["非法 type", { type: "pdf", text: "x" }, 400],
    ["tags 非数组", { type: "text", text: "x", tags: "a" }, 400],
    ["tags 含空串", { type: "text", text: "x", tags: [""] }, 400],
    ["tags 超过 10 个", { type: "text", text: "x", tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, 400],
    ["标签过长", { type: "text", text: "x", tags: ["字".repeat(33)] }, 400],
    ["url 非 http", { type: "url", url: "ftp://example.com/x" }, 400],
    ["url 带口令", { type: "url", url: "https://u:p@example.com/" }, 400],
    ["url 非字符串", { type: "url", url: 5 }, 400],
    ["超长", { type: "text", text: "字".repeat(500_001) }, 413],
  ];
  for (const [name, body, status] of bad) expect((await capture(body)).status, name).toBe(status);
  expect((await call("POST", "/v1/documents", { type: "text", text: "x" })).status).toBe(400);
  expect((await call("POST", "/v1/documents", { client_request_id: "nope", type: "text", text: "x" })).status).toBe(400);
  expect((await capture({ type: "text", text: "字".repeat(500_000) })).status).toBe(202); // 恰好 50 万字符可以
});

test("S12：上传文件名为 ../../x.md —— 文件名只当标题用，数据目录之外没有任何文件；blob 路径只由哈希决定", async () => {
  const form = new FormData();
  form.set("file", new File(["# 上传的笔记\n\n内容"], "../../x.md", { type: "text/markdown" }));
  form.set("client_request_id", crid());
  form.set("tags", JSON.stringify(["上传"]));
  const r = await h.app.request("/v1/documents", { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN }, body: form });
  expect(r.status).toBe(202);
  const b = await json(r);
  await done();
  const d = await detail(b.document_id as string);
  expect(d).toMatchObject({ source_type: "markdown", title: "上传的笔记", tags: ["上传"], status: "ready" });
  // 没有文件名叫 x.md 的东西出现在任何地方
  const all = (p: string): string[] => readdirSync(p, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(join(p, e.name)) : [join(p, e.name)]));
  expect(all(dir).some((f) => f.endsWith("x.md"))).toBe(false);
  expect(existsSync(join(dir, "x.md"))).toBe(false);
  for (const f of all(join(dataDir, "blobs"))) expect(f).toMatch(/blobs[\\/][0-9a-f]{2}[\\/][0-9a-f]{62}$/);
  // 没有标题时才用文件名：文件名里的路径与控制字符被去掉
  const f2 = new FormData();
  f2.set("file", new File(["纯文本"], "..\\..\\a\u0007b.txt"));
  f2.set("client_request_id", crid());
  const r2 = await h.app.request("/v1/documents", { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN }, body: f2 });
  await done();
  expect((await detail((await json(r2)).document_id as string)).title).toBe("a b");
  // 下载文件名由 ID 生成，不含上传时的文件名
  const raw = await call("GET", `/v1/documents/${b.document_id}/versions/${(d.versions as J[])[0]!.id}/raw`);
  expect(raw.headers.get("content-disposition")).not.toMatch(/x\.md|\.\./);
});

test("上传校验：只收 .md / .markdown / .txt；> 2 MB → 413；非 UTF-8 → 400；缺 file → 400；超过请求体上限 → 413", async () => {
  const send = (file: File | undefined, extra: Record<string, string> = {}) => {
    const f = new FormData();
    if (file) f.set("file", file);
    f.set("client_request_id", crid());
    for (const [k, v] of Object.entries(extra)) f.set(k, v);
    return h.app.request("/v1/documents", { method: "POST", headers: { Cookie: cookie, Origin: ORIGIN }, body: f });
  };
  expect((await send(new File(["x"], "a.exe"))).status).toBe(422);
  expect(((await json(await send(new File(["x"], "a.pdf")))).error as J).code).toBe("unsupported_type");
  expect((await send(new File([new Uint8Array(2 * 1024 * 1024 + 1).fill(97)], "big.txt"))).status).toBe(413);
  expect((await send(new File([new Uint8Array(4 * 1024 * 1024).fill(97)], "huge.txt"))).status).toBe(413); // 被请求体上限挡住
  expect((await send(new File([new Uint8Array([0xff, 0xfe, 0xfd])], "bad.txt"))).status).toBe(400);
  expect((await send(undefined)).status).toBe(400);
  expect((await send(new File(["x"], "a.md"), { tags: "not json" })).status).toBe(400);
  // 正文 ≤50 万字符的限制比 2 MB 更紧：2 MB 的 ASCII 文件也会因超过 50 万字符被拒绝
  expect((await send(new File([new Uint8Array(2 * 1024 * 1024).fill(97)], "dense.txt"))).status).toBe(413);
  expect((await send(new File([new Uint8Array(500_001).fill(97)], "over.txt"))).status).toBe(413);
  expect((await send(new File([new Uint8Array(500_000).fill(97)], "ok.txt"))).status).toBe(202); // 恰好 50 万字符可以
});

test("URL：规范化后抓取 → 抽取正文 → 标题换成真实标题；追踪参数被去掉；站点导航 / 页脚不在正文里", async () => {
  const port = await site((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(article("间隔重复的科学")); });
  const r = await captureUrl(`http://Blog.TEST:${port}/post?b=2&utm_source=wx&a=1#top`, { tags: ["学习"] });
  expect(r.status).toBe(202);
  const b = await json(r);
  await done();
  expect(fetchLog).toEqual(["GET /robots.txt", "GET /post?a=1&b=2"]); // 先查 robots.txt，再抓规范化后的 URL
  const d = await detail(b.document_id as string);
  expect(d).toMatchObject({ source_type: "url", source_uri: `http://blog.test:${port}/post?a=1&b=2`, title: "间隔重复的科学", status: "ready", tags: ["学习"] });
  const v = (d.versions as J[])[0]!;
  expect(v).toMatchObject({ status: "ready", current: true, parser_version: "readability@0.6+turndown@7" });
  const md = await (await call("GET", `/v1/documents/${b.document_id}/versions/${v.id}/text`)).text();
  expect(md).toContain("遗忘曲线");
  expect(md).not.toContain("京ICP备");
  expect(md).not.toContain("首页");
  const raw = await (await call("GET", `/v1/documents/${b.document_id}/versions/${v.id}/raw`)).text();
  expect(raw).toContain("京ICP备"); // 原始 HTML 保留
});

test("字符集：GBK 页面（HTTP 头声明）正确解码", async () => {
  const gbk = Buffer.concat([Buffer.from("<html><head><title>"), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), Buffer.from("</title></head><body><article><p>"), Buffer.concat(Array.from({ length: 150 }, () => Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))), Buffer.from("</p></article></body></html>")]);
  const port = await site((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=gbk" }); res.end(gbk); });
  const b = await json(await captureUrl(`http://gbk.test:${port}/`));
  await done();
  const d = await detail(b.document_id as string);
  expect(d.title).toBe("你好");
  const md = await (await call("GET", `/v1/documents/${b.document_id}/versions/${(d.versions as J[])[0]!.id}/text`)).text();
  expect(md).toContain("你好你好你好");
  expect(md).not.toContain("�");
});

test("版本：同一 URL 同一天再次采集 → 同一个作业（deduplicated）；隔天内容未变 → 不产生新版本；内容变化 → 新版本，旧版本保留", async () => {
  let body = article("版本测试");
  const port = await site((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(body); });
  const url = `http://v.test:${port}/p`;
  const first = await json(await captureUrl(url));
  await done();
  const same = await captureUrl(url);
  expect(same.status).toBe(200);
  expect(await json(same)).toMatchObject({ document_id: first.document_id, job_id: first.job_id, deduplicated: true });
  expect(await versionsOf(first.document_id as string)).toHaveLength(1);

  clock.advance(24 * 3600 * 1000); // 隔天
  const day2 = await json(await captureUrl(url));
  expect(day2).toMatchObject({ document_id: first.document_id, deduplicated: false });
  expect(day2.job_id).not.toBe(first.job_id);
  await done();
  expect(await versionsOf(first.document_id as string)).toHaveLength(1); // 内容没变

  body = article("版本测试", "这是第三天新增的一段内容。");
  clock.advance(24 * 3600 * 1000);
  await captureUrl(url);
  await done();
  const vs = await versionsOf(first.document_id as string);
  expect(vs).toHaveLength(2);
  expect(vs.map((v) => v.current)).toEqual([true, false]); // 新版本在前且为当前
  const [newer, older] = vs as [J, J];
  const oldText = await (await call("GET", `/v1/documents/${first.document_id}/versions/${older.id}/text`)).text();
  const newText = await (await call("GET", `/v1/documents/${first.document_id}/versions/${newer.id}/text`)).text();
  expect(oldText).not.toContain("第三天新增");
  expect(newText).toContain("第三天新增");
  expect(((await json(await call("GET", "/v1/documents"))).items as J[]).length).toBe(1); // 仍是一份资料

  // 内容又变回旧版本：当前指向旧版本，不再新建
  body = article("版本测试");
  clock.advance(24 * 3600 * 1000);
  await captureUrl(url);
  await done();
  const back = await versionsOf(first.document_id as string);
  expect(back).toHaveLength(2);
  expect(back.find((v) => v.current)!.id).toBe(older.id);
});

test("失败路径：robots 不允许 / 不支持的类型 / 404 / SSRF 都立即 failed 不重试，资料标 failed 并带错误码；SSRF 目标从未被连接", async () => {
  const port = await site((req, res) => {
    if (req.url === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("User-agent: *\nDisallow: /private\n"); }
    if (req.url === "/pdf") { res.writeHead(200, { "content-type": "application/pdf" }); return res.end("%PDF"); }
    if (req.url === "/gone") { res.writeHead(404, { "content-type": "text/html" }); return res.end("nope"); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html/>");
  });
  const cases: [string, string, string][] = [
    [`http://f.test:${port}/private/doc`, "robots_disallowed", "robots"],
    [`http://f.test:${port}/pdf`, "unsupported_type", "pdf"],
    [`http://f.test:${port}/gone`, "fetch_failed", "404"],
  ];
  for (const [url, code] of cases) {
    const b = await json(await captureUrl(url));
    await done();
    const j = await json(await call("GET", `/v1/jobs/${b.job_id}`));
    expect([j.status, j.error_code, j.attempts], url).toEqual(["failed", code, 1]);
    const d = await detail(b.document_id as string);
    expect([d.status, d.error_code], url).toEqual(["failed", code]);
    expect(d.versions).toEqual([]);
  }
  // SSRF：用默认（严格）策略——本机站点即使在监听也不会被连接
  await worker.stop(); // 同一个库上不能有两个 worker：否则主 worker（宽松策略）会抢走作业
  const holder: { w?: JobWorker } = {};
  const strict = new KnowledgeService({ db, blobs: new BlobStore(join(dataDir, "blobs")), clock, wake: () => holder.w?.wake() });
  const strictWorker = (holder.w = new JobWorker(db, clock, strict.handlers(), { onFinished: (j) => strict.onJobFinished(j) }));
  strictWorker.start();
  const hitsBefore = fetchLog.length;
  const s = await strict.captureUrl(ownerId, { clientRequestId: crid(), url: `http://127.0.0.1:${port}/secret` });
  await strictWorker.idle();
  const j = await json(await call("GET", `/v1/jobs/${s.jobId}`));
  expect([j.status, j.error_code, j.attempts]).toEqual(["failed", "ssrf_blocked", 1]);
  expect(fetchLog.length).toBe(hitsBefore);
  await strictWorker.stop();
});

test("可重试的失败：5xx 按退避重试后成功；全部失败后可手动重试；已有可用版本的资料抓取失败时保持 ready", async () => {
  let mode: "ok" | "503" = "503";
  const port = await site((req, res) => {
    if (req.url === "/robots.txt") { res.writeHead(404); return res.end(); }
    if (mode === "503") { res.writeHead(503, { "content-type": "text/html" }); return res.end("busy"); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(article("重试测试"));
  });
  const url = `http://r.test:${port}/p`;
  const b = await json(await captureUrl(url));
  await done();
  let j = await json(await call("GET", `/v1/jobs/${b.job_id}`));
  expect([j.status, j.attempts, j.error_code]).toEqual(["queued", 1, "fetch_failed"]);
  expect((await detail(b.document_id as string)).status).toBe("pending"); // 还在重试，不算失败
  mode = "ok";
  clock.advance(30_000);
  await done();
  j = await json(await call("GET", `/v1/jobs/${b.job_id}`));
  expect([j.status, j.attempts, j.error_code]).toEqual(["succeeded", 2, null]);
  expect((await detail(b.document_id as string)).status).toBe("ready");

  // 持续 503：3 次后 failed；恢复后手动重试
  mode = "503";
  const b2 = await json(await captureUrl(`http://r.test:${port}/q`));
  await done();
  clock.advance(30_000);
  await done();
  clock.advance(30_000);
  await done();
  let j2 = await json(await call("GET", `/v1/jobs/${b2.job_id}`));
  expect([j2.status, j2.attempts]).toEqual(["failed", 3]);
  expect((await detail(b2.document_id as string)).status).toBe("failed");
  mode = "ok";
  expect((await call("POST", `/v1/jobs/${b2.job_id}/retry`)).status).toBe(200);
  await done();
  j2 = await json(await call("GET", `/v1/jobs/${b2.job_id}`));
  expect([j2.status, j2.attempts]).toEqual(["succeeded", 1]);
  expect((await detail(b2.document_id as string)).status).toBe("ready");

  // 已 ready 的资料，隔天重新抓取失败（站点出问题）：资料保持 ready，旧版本仍可用
  mode = "503";
  clock.advance(24 * 3600 * 1000);
  const again = await json(await captureUrl(url));
  for (let i = 0; i < 4; i++) { await done(); clock.advance(30_000); }
  await done();
  expect((await json(await call("GET", `/v1/jobs/${again.job_id}`))).status).toBe("failed");
  const d = await detail(b.document_id as string);
  expect(d.status).toBe("ready");
  expect(d.versions as J[]).toHaveLength(1);
});

test("列表：状态 / 标签 / 标题前缀过滤（LIKE 通配符被转义）、分页、最近更新在前", async () => {
  const mk = async (title: string, tags: string[] = []) => json(await captureText(`${title} 的正文`, { title, tags }));
  const a = await mk("读书笔记：间隔重复", ["学习"]);
  await mk("读书笔记：概率论", ["数学", "学习"]);
  await mk("100% 完成清单");
  await mk("a_b 下划线");
  await done();
  await call("POST", `/v1/documents/${a.document_id}/revoke`);
  const list = async (q: string) => ((await json(await call("GET", `/v1/documents${q}`))).items as J[]).map((d) => d.title);
  expect(await list("?tag=学习")).toHaveLength(2);
  expect(await list(`?tag=${encodeURIComponent("数学")}`)).toEqual(["读书笔记：概率论"]);
  expect(await list(`?q=${encodeURIComponent("读书")}`)).toHaveLength(2);
  expect(await list(`?q=${encodeURIComponent("100%")}`)).toEqual(["100% 完成清单"]); // % 不当通配符
  expect(await list(`?q=${encodeURIComponent("%")}`)).toEqual([]);
  expect(await list(`?q=${encodeURIComponent("a_")}`)).toEqual(["a_b 下划线"]);
  expect(await list(`?q=${encodeURIComponent("a%")}`)).toEqual([]);
  expect(await list("?status=revoked")).toEqual(["读书笔记：间隔重复"]);
  expect(await list("?status=ready")).toHaveLength(3);
  const p1 = await json(await call("GET", "/v1/documents?limit=3"));
  expect((p1.items as J[]).length).toBe(3);
  const p2 = await json(await call("GET", `/v1/documents?limit=3&cursor=${p1.next_cursor}`));
  expect((p2.items as J[]).length).toBe(1);
  expect(p2.next_cursor).toBeNull();
  const ids = [...(p1.items as J[]), ...(p2.items as J[])].map((d) => d.id);
  expect(new Set(ids).size).toBe(4);
  expect((await call("GET", "/v1/documents?limit=0")).status).toBe(400);
  expect((await call("GET", "/v1/documents?cursor=garbage")).status).toBe(400);
});

test("更新与状态：改标题 / 标签；停止使用 / 恢复（幂等）；pending 不能停止使用；owner 隔离", async () => {
  const b = await json(await captureText("正文", { title: "原标题" }));
  expect((await call("POST", `/v1/documents/${b.document_id}/revoke`)).status).toBe(400); // 还是 pending
  await done();
  expect(await json(await call("PATCH", `/v1/documents/${b.document_id}`, { title: "新标题", tags: ["x"] }))).toMatchObject({ title: "新标题", tags: ["x"] });
  expect((await call("PATCH", `/v1/documents/${b.document_id}`, { title: "   " })).status).toBe(400);
  expect((await call("PATCH", `/v1/documents/${b.document_id}`, { tags: "x" })).status).toBe(400);
  expect((await json(await call("POST", `/v1/documents/${b.document_id}/revoke`))).status).toBe("revoked");
  expect((await json(await call("POST", `/v1/documents/${b.document_id}/revoke`))).status).toBe("revoked"); // 幂等
  expect((await json(await call("POST", `/v1/documents/${b.document_id}/restore`))).status).toBe("ready");
  expect((await call("POST", `/v1/documents/${b.document_id}/restore`)).status).toBe(200);

  const now = Date.now();
  await db.run("INSERT INTO app_owners (id, display_name, timezone, created_at) VALUES ('other','x','UTC',?)", now);
  await db.run("INSERT INTO app_documents (id, owner_id, source_type, title, status, created_at, updated_at) VALUES ('foreign','other','text','别人的','ready',?,?)", now, now);
  for (const [m, p] of [["GET", "/v1/documents/foreign"], ["PATCH", "/v1/documents/foreign"], ["POST", "/v1/documents/foreign/revoke"], ["GET", "/v1/documents/foreign/versions/x/text"], ["GET", "/v1/jobs/nope"]] as const) {
    expect((await call(m, p, m === "PATCH" ? { title: "x" } : undefined)).status, `${m} ${p}`).toBe(404);
  }
  expect(((await json(await call("GET", "/v1/documents"))).items as J[]).map((d) => d.id)).not.toContain("foreign");
  // 版本必须属于该资料
  const other = await json(await captureText("另一篇"));
  await done();
  const otherV = (await versionsOf(other.document_id as string))[0]!;
  expect((await call("GET", `/v1/documents/${b.document_id}/versions/${otherV.id}/text`)).status).toBe(404);
});

test("采集限流：每分钟 20 次，超出 429", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 21; i++) codes.push((await captureText(`内容 ${i}`)).status);
  expect(codes.slice(0, 20).every((c) => c === 202)).toBe(true);
  expect(codes[20]).toBe(429);
});
