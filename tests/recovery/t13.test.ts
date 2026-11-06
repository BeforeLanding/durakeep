// T-13：R13（采集部分）×20——作业在 job.after_fetch（原文已写入 blob、版本记录尚未写入）被杀，
// 重启后恢复扫描把 running 改回 queued，作业从 checkpoint 继续：不重复抓取、不产生重复版本。
// 另有 ×20：在重试窗口内（第一次抓取失败后）被杀，重启后仍能完成。
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { freePort, get, initOwner, loginCookie, post, startServer, type Server } from "../support/server.ts";

const REPEAT = Number(process.env.REPEAT ?? 20);
const para = "间隔重复是一种根据遗忘曲线安排复习时间的学习方法，它的核心思想是在即将遗忘的时刻进行复习，从而用最少的复习次数获得最长的记忆保持。";
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>崩溃恢复测试页 - 站点</title></head><body><nav>导航</nav><article><h1>崩溃恢复测试页</h1><p>${para}${para}</p><p>${para}</p></article><footer>页脚</footer></body></html>`;
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `durakeep-${p}-`));

function listFiles(d: string): string[] {
  return existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(d, e.name)) : [join(d, e.name)])) : [];
}

async function pageSite(): Promise<{ port: number; hits: Record<string, number>; close(): Promise<void> }> {
  const hits: Record<string, number> = {};
  const s: HttpServer = createServer((req, res) => {
    hits[req.url ?? ""] = (hits[req.url ?? ""] ?? 0) + 1;
    if (req.url === "/robots.txt") {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { port: (s.address() as AddressInfo).port, hits, close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

async function waitReady(base: string, cookie: string, documentId: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = (await (await get(base, `/v1/documents/${documentId}`, cookie)).json()) as { status: string; versions: { id: string; status: string; current: boolean }[]; error_code: string | null };
    if (d.status === "ready" || d.status === "failed") return d;
    if (Date.now() > deadline) throw new Error(`资料未在 ${timeoutMs}ms 内完成：${JSON.stringify(d)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test(`R13 × ${REPEAT}：job.after_fetch 被杀 → 重启 → 从 checkpoint 继续，不重复抓取、不产生重复版本`, async () => {
  const failures: string[] = [];
  const site = await pageSite();
  try {
    for (let i = 0; i < REPEAT; i++) {
      const dir = tmp("t13");
      let s1: Server | undefined;
      let s2: Server | undefined;
      try {
        await initOwner(dir);
        const port = await freePort();
        const env = { FETCH_ALLOW_LOOPBACK: "1" };
        s1 = await startServer(dir, port, { ...env, FAULT_POINT: "job.after_fetch" });
        const cookie = await loginCookie(s1.base);
        const before = { ...site.hits };
        const url = `http://127.0.0.1:${site.port}/post-${i}?utm_source=x`;
        const r = await post(s1.base, "/v1/documents", cookie, { client_request_id: crypto.randomUUID(), type: "url", url });
        const created = (await r.json()) as { document_id: string; job_id: string };
        const code = await s1.exited; // 作业在 after_fetch 把整个进程杀掉
        if (r.status !== 202 || code === 0) failures.push(`#${i} 首次请求 ${r.status}，服务退出码 ${code}`);

        s2 = await startServer(dir, port, env);
        const d = await waitReady(s2.base, cookie, created.document_id);
        const job = (await (await get(s2.base, `/v1/jobs/${created.job_id}`, cookie)).json()) as { status: string; attempts: number };
        await s2.stop();

        const fetched = (site.hits[`/post-${i}`] ?? 0) - (before[`/post-${i}`] ?? 0);
        const blobFiles = listFiles(join(dir, "blobs"));
        const ok =
          d.status === "ready" &&
          d.versions.length === 1 &&
          d.versions[0]!.status === "ready" &&
          d.versions[0]!.current === true &&
          job.status === "succeeded" &&
          job.attempts === 2 &&
          fetched === 1 && // checkpoint 里已有原文，重启后没有再抓一次
          blobFiles.length === 2 && // 原始 HTML + 抽取出的正文，各一份
          blobFiles.every((f) => !f.endsWith(".tmp"));
        if (!ok) failures.push(`#${i} ${JSON.stringify({ status: d.status, versions: d.versions.length, job, fetched, blobs: blobFiles.length })}`);
      } finally {
        await s1?.stop();
        await s2?.stop();
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  } finally {
    await site.close();
  }
  expect(failures).toEqual([]);
}, 900_000);

test(`R13 补充 × ${REPEAT}：同一 URL 在隔天重新采集时于 job.after_fetch 被杀 → 重启后不产生重复版本，内容未变则仍只有一个版本`, async () => {
  // 用同一份数据目录：先正常采集一次（得到 1 个版本），再让第二次采集（相同内容）在 after_fetch 被杀
  const failures: string[] = [];
  const site = await pageSite();
  try {
    for (let i = 0; i < REPEAT; i++) {
      const dir = tmp("t13b");
      let s1: Server | undefined;
      let s2: Server | undefined;
      try {
        await initOwner(dir);
        const port = await freePort();
        const env = { FETCH_ALLOW_LOOPBACK: "1" };
        const url = `http://127.0.0.1:${site.port}/again-${i}`;
        s1 = await startServer(dir, port, env);
        const cookie = await loginCookie(s1.base);
        const first = (await (await post(s1.base, "/v1/documents", cookie, { client_request_id: crypto.randomUUID(), type: "url", url })).json()) as { document_id: string };
        await waitReady(s1.base, cookie, first.document_id);
        await s1.stop();

        // 同一天再次采集会被作业去重；所以直接清掉当天的作业记录模拟“隔天”，再带故障点重启
        const { DatabaseSync } = await import("node:sqlite");
        const raw = new DatabaseSync(join(dir, "app.sqlite"));
        raw.exec("DELETE FROM app_jobs; DELETE FROM app_operations;");
        raw.close();

        s1 = await startServer(dir, port, { ...env, FAULT_POINT: "job.after_fetch" });
        const cookie2 = await loginCookie(s1.base);
        const r = await post(s1.base, "/v1/documents", cookie2, { client_request_id: crypto.randomUUID(), type: "url", url });
        const again = (await r.json()) as { document_id: string; job_id: string };
        await s1.exited;
        s2 = await startServer(dir, port, env);
        const deadline = Date.now() + 20_000;
        let job: { status: string; attempts: number } = { status: "queued", attempts: 0 };
        while (Date.now() < deadline) {
          job = (await (await get(s2.base, `/v1/jobs/${again.job_id}`, cookie2)).json()) as typeof job;
          if (job.status === "succeeded" || job.status === "failed") break;
          await new Promise((r2) => setTimeout(r2, 50));
        }
        const d = (await (await get(s2.base, `/v1/documents/${first.document_id}`, cookie2)).json()) as { status: string; versions: unknown[] };
        await s2.stop();
        if (again.document_id !== first.document_id || r.status !== 202) failures.push(`#${i} 资料不是同一份或状态码 ${r.status}`);
        if (job.status !== "succeeded" || d.status !== "ready" || d.versions.length !== 1) failures.push(`#${i} ${JSON.stringify({ job, status: d.status, versions: d.versions.length })}`);
      } finally {
        await s1?.stop();
        await s2?.stop();
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  } finally {
    await site.close();
  }
  expect(failures).toEqual([]);
}, 900_000);
