// 检索评测（07 §7.1，零费用）：把语料目录里的文本逐个采集进临时库，用 KnowledgeRetrieval.search（与 kb_search 同一条链路，top_k=10）
// 跑 tests/retrieval/eval.jsonl，输出 Recall@10、MRR、按标签的召回率，写 tests/retrieval/reports/<日期>.md。
// 用法：EVAL_CORPUS_DIR=<语料目录> node scripts/eval-retrieval.ts
// 语料是用户的授权资料，不入库：目录由环境变量给出（默认 tests/retrieval/corpus，已被 gitignore）。报告只含题号、查询、名次，不含资料原文。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KnowledgeRetrieval } from "../packages/knowledge/src/index.ts";
import { questions, root, setupCorpus, squash, validateQuestions, type Q } from "./eval-common.ts";

const env = await setupCorpus();
const { db, owner, keyByDocId, docText, totalChars, chunkCount } = env;
const invalid = validateQuestions(docText);
if (invalid.length > 0) {
  console.error(["题目自检失败：", ...invalid].join("\n"));
  await env.close();
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

await env.close();
process.exit(recall >= 0.9 ? 0 : 1);
