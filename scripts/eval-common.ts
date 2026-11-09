// 两个评测脚本共用：题目、语料采集进临时库。语料目录由 EVAL_CORPUS_DIR 给出（用户的授权资料，不入库）。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { FakeClock } from "../packages/core/src/index.ts";
import { guardDb, migrate, type SqlDatabase } from "../packages/db/src/index.ts";
import { JobWorker } from "../packages/jobs/src/index.ts";
import { BlobStore, createChunkIndexer, KnowledgeService } from "../packages/knowledge/src/index.ts";
import { openAppDatabase } from "../packages/runtime-pi/src/index.ts";

export type Rel = { doc: string; contains: string };
export type Q = { id: string; type: "answerable" | "unanswerable"; query: string; relevant?: Rel[]; tags?: string[] };

export const root = resolve(import.meta.dirname, "..");
export const corpusDir = resolve(process.env.EVAL_CORPUS_DIR ?? join(root, "tests/retrieval/corpus"));
export const corpus = JSON.parse(readFileSync(join(root, "tests/retrieval/corpus.json"), "utf8")) as Record<string, string>;
export const questionsRaw = readFileSync(join(root, "tests/retrieval/eval.jsonl"), "utf8");
export const questions = questionsRaw
  .split(/\r?\n/)
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as Q);
/** PDF 抽取带有换行造成的空格，比较时两边都去掉空白 */
export const squash = (s: string) => s.replace(/\s+/g, "");
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function setupCorpus() {
  const tmp = mkdtempSync(join(tmpdir(), "durakeep-eval-"));
  const raw = await openAppDatabase(join(tmp, "app.sqlite"));
  const db: SqlDatabase = guardDb(raw);
  await migrate(db);
  const clock = new FakeClock(Date.UTC(2026, 10, 9, 0, 0));
  const owner = "eval-owner";
  await db.run("INSERT INTO app_owners (id, display_name, timezone, created_at) VALUES (?, '评测', 'Asia/Shanghai', ?)", owner, clock.now());
  const knowledge = new KnowledgeService({ db, blobs: new BlobStore(join(tmp, "blobs")), clock, indexer: createChunkIndexer(db), wake: () => worker.wake() });
  const worker = new JobWorker(db, clock, knowledge.handlers(), { onFinished: (j) => knowledge.onJobFinished(j) });
  worker.start();
  const docText = new Map<string, string>();
  const keyByDocId = new Map<string, string>();
  let totalChars = 0;
  for (const [key, file] of Object.entries(corpus)) {
    const text = readFileSync(join(corpusDir, file), "utf8");
    docText.set(key, squash(text));
    totalChars += text.length;
    const r = await knowledge.captureText(owner, { clientRequestId: crypto.randomUUID(), kind: "text", title: key, text, tags: [] });
    keyByDocId.set(r.documentId, key);
  }
  await worker.idle(600_000);
  const chunkCount = (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM app_chunks WHERE owner_id = ?", owner))!.n;
  return {
    tmp, raw, db, owner, knowledge, worker, docText, keyByDocId, totalChars, chunkCount, clock,
    async close() {
      await worker.stop();
      await raw.close();
      rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/** 题目自检：relevant 的 doc 必须存在，contains 必须出现在该资料原文里 */
export function validateQuestions(docText: Map<string, string>): string[] {
  const invalid: string[] = [];
  for (const q of questions) {
    if (q.type === "answerable" && (!q.relevant || q.relevant.length === 0)) invalid.push(`${q.id}：缺少 relevant`);
    for (const r of q.relevant ?? []) {
      const t = docText.get(r.doc);
      if (t === undefined) invalid.push(`${q.id}：未知资料 ${r.doc}`);
      else if (!t.includes(squash(r.contains))) invalid.push(`${q.id}：资料 ${r.doc} 中找不到“${r.contains}”`);
    }
  }
  return invalid;
}
