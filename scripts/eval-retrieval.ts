// 检索评测（07 §7.1，零费用）：把语料目录里的文本逐个采集进临时库，用 KnowledgeRetrieval.search（与 kb_search 同一条链路，top_k=10）
// 跑 tests/retrieval/eval.jsonl，输出 Recall@10、MRR、按标签的召回率，写 tests/retrieval/reports/<日期>.md。
// 用法：EVAL_CORPUS_DIR=<语料目录> node scripts/eval-retrieval.ts
// 语料是用户的授权资料，不入库：目录由环境变量给出（默认 tests/retrieval/corpus，已被 gitignore）。报告只含题号、查询、名次，不含资料原文。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeClock } from "../packages/core/src/index.ts";
import { guardDb, migrate } from "../packages/db/src/index.ts";
import { JobWorker } from "../packages/jobs/src/index.ts";
import { BlobStore, createChunkIndexer, KnowledgeRetrieval, KnowledgeService } from "../packages/knowledge/src/index.ts";
import { openAppDatabase } from "../packages/runtime-pi/src/index.ts";

type Rel = { doc: string; contains: string };
type Q = { id: string; type: "answerable" | "unanswerable"; query: string; relevant?: Rel[]; tags?: string[] };

const root = resolve(import.meta.dirname, "..");
const corpusDir = resolve(process.env.EVAL_CORPUS_DIR ?? join(root, "tests/retrieval/corpus"));
const corpus = JSON.parse(readFileSync(join(root, "tests/retrieval/corpus.json"), "utf8")) as Record<string, string>;
const questions = readFileSync(join(root, "tests/retrieval/eval.jsonl"), "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as Q);
// PDF 抽取带有换行造成的空格，比较时两边都去掉空白
const squash = (s: string) => s.replace(/\s+/g, "");

const tmp = mkdtempSync(join(tmpdir(), "durakeep-eval-"));
const raw = await openAppDatabase(join(tmp, "app.sqlite"));
const db = guardDb(raw);
await migrate(db);
const clock = new FakeClock(Date.UTC(2026, 10, 9, 0, 0));
const owner = "eval-owner";
await db.run("INSERT INTO app_owners (id, display_name, timezone, created_at) VALUES (?, '评测', 'Asia/Shanghai', ?)", owner, clock.now());
const knowledge = new KnowledgeService({ db, blobs: new BlobStore(join(tmp, "blobs")), clock, indexer: createChunkIndexer(db), wake: () => worker.wake() });
const worker = new JobWorker(db, clock, knowledge.handlers(), { onFinished: (j) => knowledge.onJobFinished(j) });
worker.start();

const docText = new Map<string, string>(); // key → 原文（去空白）
const docIdByKey = new Map<string, string>();
const keyByDocId = new Map<string, string>();
let totalChars = 0;
for (const [key, file] of Object.entries(corpus)) {
  const text = readFileSync(join(corpusDir, file), "utf8");
  docText.set(key, squash(text));
  totalChars += text.length;
  const r = await knowledge.captureText(owner, { clientRequestId: crypto.randomUUID(), kind: "text", title: key, text, tags: [] });
  docIdByKey.set(key, r.documentId);
  keyByDocId.set(r.documentId, key);
}
await worker.idle(600_000);
const chunkCount = (await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM app_chunks WHERE owner_id = ?", owner))!.n;

// 题目自检：relevant 的 doc 必须存在，contains 必须出现在该资料原文里（否则题目本身无效）
const invalid: string[] = [];
for (const q of questions) {
  if (q.type === "answerable" && (!q.relevant || q.relevant.length === 0)) invalid.push(`${q.id}：缺少 relevant`);
  for (const r of q.relevant ?? []) {
    const t = docText.get(r.doc);
    if (t === undefined) invalid.push(`${q.id}：未知资料 ${r.doc}`);
    else if (!t.includes(squash(r.contains))) invalid.push(`${q.id}：资料 ${r.doc} 中找不到“${r.contains}”`);
  }
}
if (invalid.length > 0) {
  console.error("题目自检失败：\n" + invalid.join("\n"));
  await worker.stop();
  await raw.close();
  rmSync(tmp, { recursive: true, force: true });
  process.exit(2);
}

const retrieval = new KnowledgeRetrieval(db);
type Row = { q: Q; rank: number | null; returned: number };
const rows: Row[] = [];
for (const q of questions) {
  const res = await retrieval.search(owner, { query: q.query, topK: 10 });
  const groups = ((res.details as { results?: { chunk_ids: number[]; document_id: string }[] }).results ?? []);
  let rank: number | null = null;
  if (q.type === "answerable") {
    for (const [i, g] of groups.entries()) {
      const texts = await db.all<{ text: string }>(`SELECT text FROM app_chunks WHERE owner_id = ? AND id IN (${g.chunk_ids.map(() => "?").join(",")})`, owner, ...g.chunk_ids);
      const joined = squash(texts.map((t) => t.text).join("\n"));
      const hit = q.relevant!.some((r) => keyByDocId.get(g.document_id) === r.doc && joined.includes(squash(r.contains)));
      if (hit) {
        rank = i + 1;
        break;
      }
    }
  }
  rows.push({ q, rank, returned: groups.length });
}

const ans = rows.filter((r) => r.q.type === "answerable");
const recall = ans.filter((r) => r.rank !== null).length / ans.length;
const mrr = ans.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / ans.length;
const tags = new Map<string, Row[]>();
for (const r of ans) for (const t of r.q.tags ?? ["（无标签）"]) tags.set(t, [...(tags.get(t) ?? []), r]);
const pct = (x: number) => (x * 100).toFixed(1) + "%";
const unans = rows.filter((r) => r.q.type === "unanswerable");

const lines: string[] = [];
lines.push(`# 检索评测报告 ${new Date().toISOString().slice(0, 10)}`, "");
lines.push(`- 语料：${docText.size} 篇，${totalChars} 字符，${chunkCount} 个片段；分块 / 分词版本以代码为准。`);
lines.push(`- 题目：有答案 ${ans.length}，无答案 ${unans.length}（版本 / 冲突类题目尚未加入，见 PROGRESS 的已知缺口）。`);
lines.push(`- **Recall@10：${pct(recall)}**（${ans.filter((r) => r.rank !== null).length}/${ans.length}） **MRR：${mrr.toFixed(3)}** 判定：${recall >= 0.9 ? "达标（≥90%）" : "未达标（<90%）"}`, "");
lines.push("## 按标签", "", "| 标签 | 题数 | Recall@10 | MRR |", "|---|---|---|---|");
for (const [t, rs] of tags) lines.push(`| ${t} | ${rs.length} | ${pct(rs.filter((r) => r.rank !== null).length / rs.length)} | ${(rs.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / rs.length).toFixed(3)} |`);
lines.push("", "## 逐题（有答案）", "", "| 题号 | 查询 | 名次 |", "|---|---|---|");
for (const r of ans) lines.push(`| ${r.q.id} | ${r.q.query} | ${r.rank ?? "**未命中**"} |`);
lines.push("", "## 无答案题", "", "检索本身不判断“有没有答案”（词法 OR 检索总会返回最接近的片段）；这类题的“资料不足”判定由回答评测（T-19）检验。这里只记录检索返回了多少组结果。", "", "| 题号 | 查询 | 返回组数 |", "|---|---|---|");
for (const r of unans) lines.push(`| ${r.q.id} | ${r.q.query} | ${r.returned} |`);
const out = join(root, "tests/retrieval/reports", `${new Date().toISOString().slice(0, 10)}.md`);
mkdirSync(join(root, "tests/retrieval/reports"), { recursive: true });
writeFileSync(out, lines.join("\n") + "\n");
console.log(lines.slice(0, 5).join("\n"));
console.log("未命中：", ans.filter((r) => r.rank === null).map((r) => `${r.q.id}「${r.q.query}」`).join("；") || "（无）");
console.log("报告：", out);

await worker.stop();
await raw.close();
rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
process.exit(recall >= 0.9 ? 0 : 1);
