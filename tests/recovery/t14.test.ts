// T-14：R13（索引部分）×20——索引在 job.mid_index（写入第 2 批片段之后）被杀：
//  · 崩溃当时：块与两张 FTS 表的行成对存在（不变式 2），半成品不可检索（active=0），资料还是 pending；
//  · 重启后：作业从已写入的块继续，补齐剩余批次；块数与纯函数分块一致、序号连续、无重复，FTS 一致，资料 ready 且可检索。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { chunkMarkdown } from "../../packages/knowledge/src/chunker.ts";
import { freePort, get, initOwner, loginCookie, post, startServer, type Server } from "../support/server.ts";
import { ftsConsistent, ftsReport } from "../support/fts.ts";

const REPEAT = Number(process.env.REPEAT ?? 20);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `durakeep-${p}-`));
const sentence = (n: number) => `第${n}条记录讲的是崩溃恢复测试中的索引一致性，需要足够长的文字才能切出很多个块。`;
const TEXT = `# 崩溃恢复\n\n${Array.from({ length: 1200 }, (_, i) => sentence(i)).join("")}`;
const EXPECTED = chunkMarkdown(TEXT).length; // 批大小 25：必须多于 2 批才能在第 2 批之后留下半成品

/** 服务已停止后用同步接口只读检查数据库。 */
async function inspect(dir: string) {
  const raw = new DatabaseSync(join(dir, "app.sqlite"), { readOnly: true });
  try {
    const q = (sql: string) => raw.prepare(sql).all() as Record<string, unknown>[];
    const one = (sql: string) => Object.values(q(sql)[0]!)[0] as number;
    return {
      report: await ftsReport(q),
      chunks: one("SELECT COUNT(*) FROM app_chunks"),
      active: one("SELECT COUNT(*) FROM app_chunks WHERE active = 1"),
      ordinals: q("SELECT ordinal FROM app_chunks ORDER BY ordinal").map((r) => Number(r.ordinal)),
      versions: one("SELECT COUNT(*) FROM app_document_versions"),
      docStatus: String(q("SELECT status FROM app_documents")[0]!.status),
      hits: one(`SELECT COUNT(*) FROM app_chunks_fts f JOIN app_chunks c ON c.id = f.rowid WHERE app_chunks_fts MATCH '"崩溃"' AND c.active = 1`),
      attempts: Number(q("SELECT attempts FROM app_jobs")[0]!.attempts),
    };
  } finally {
    raw.close();
  }
}

test(`R13（索引）× ${REPEAT}：job.mid_index 被杀 → 半成品一致且不可检索 → 重启后补齐，无重复，FTS 一致`, async () => {
  expect(EXPECTED).toBeGreaterThan(60); // 至少 3 批（批大小 25）
  const failures: string[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const dir = tmp("t14");
    let s1: Server | undefined;
    let s2: Server | undefined;
    try {
      await initOwner(dir);
      const port = await freePort();
      s1 = await startServer(dir, port, { FAULT_POINT: "job.mid_index", FAULT_HIT: "2" });
      const cookie = await loginCookie(s1.base);
      const r = await post(s1.base, "/v1/documents", cookie, { client_request_id: crypto.randomUUID(), type: "text", text: TEXT });
      const created = (await r.json()) as { document_id: string; job_id: string };
      const code = await s1.exited;
      if (r.status !== 202 || code === 0) failures.push(`#${i} 创建 ${r.status}，退出码 ${code}`);

      // 崩溃当时的状态
      const crashed = await inspect(dir);
      const crashOk =
        crashed.chunks === 50 && // 恰好 2 批 × 25
        ftsConsistent(crashed.report) &&
        crashed.active === 0 && // 半成品不可检索
        crashed.hits === 0 &&
        crashed.docStatus === "pending";
      if (!crashOk) failures.push(`#${i} 崩溃时状态 ${JSON.stringify({ chunks: crashed.chunks, active: crashed.active, hits: crashed.hits, doc: crashed.docStatus, report: crashed.report })}`);

      s2 = await startServer(dir, port);
      const deadline = Date.now() + 30_000;
      let doc: { status: string; versions: unknown[] } = { status: "pending", versions: [] };
      while (Date.now() < deadline) {
        doc = (await (await get(s2.base, `/v1/documents/${created.document_id}`, cookie)).json()) as typeof doc;
        if (doc.status === "ready" || doc.status === "failed") break;
        await new Promise((r2) => setTimeout(r2, 50));
      }
      await s2.stop();

      const done = await inspect(dir);
      const ok =
        doc.status === "ready" &&
        done.versions === 1 &&
        done.chunks === EXPECTED &&
        done.active === EXPECTED &&
        ftsConsistent(done.report) &&
        done.ordinals.every((o, k) => o === k) && // 序号连续，没有重复
        done.hits > 0 &&
        done.attempts === 2;
      if (!ok) failures.push(`#${i} 恢复后 ${JSON.stringify({ doc: doc.status, versions: done.versions, chunks: done.chunks, expected: EXPECTED, active: done.active, hits: done.hits, attempts: done.attempts, report: done.report })}`);
    } finally {
      await s1?.stop();
      await s2?.stop();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
  expect(failures).toEqual([]);
}, 900_000);
