// 回答评测（07 §7.2，付费）：两阶段。
//   node scripts/eval-answer.ts --dry-run              只估算 token 与费用，写 tests/retrieval/reports/answer-plan.json，不调用模型
//   node scripts/eval-answer.ts --confirm=<计划哈希>    用户批准之后才运行；哈希来自 dry-run，题目、模型或语料变了就不再匹配（批准只对那一次计划有效）
// 运行用真实 DeepSeek（需要环境变量 DEEPSEEK_API_KEY），在进程内直接驱动运行时，不经过 HTTP。APP_MODE=test|demo 时拒绝运行。
// 提交到仓库的报告只含指标和逐题标记；含回答原文与引用摘录的“人工抽查表”写到 tests/retrieval/review/（已 gitignore）。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationDirectory, ConversationService } from "../packages/conversations/src/index.ts";
import { systemClock, type AppEntry } from "../packages/core/src/index.ts";
import { CitationValidator, KnowledgeRetrieval, type Citation } from "../packages/knowledge/src/index.ts";
import { appCoreExtension, appGuardExtension, appKnowledgeExtension, PiRuntime, startPi } from "../packages/runtime-pi/src/index.ts";
import { buildPreamble } from "../packages/runtime-pi/src/extensions/appCore.ts";
import { corpus, questions, questionsRaw, root, setupCorpus, sha256, squash, validateQuestions, type Q } from "./eval-common.ts";

const MODEL = process.env.CHAT_MODEL ?? "deepseek-flash";
// 价格：USD / 百万 token，取自 pi-ai 1.5.0 的模型目录（deepseek-flash 0.3 / 1.2；deepseek-v4-pro 1.32 / 3.96）
const PRICE: Record<string, { in: number; out: number }> = { "deepseek-flash": { in: 0.3, out: 1.2 }, "deepseek-v4-pro": { in: 1.32, out: 3.96 } };
const price = PRICE[MODEL];
if (!price) throw new Error(`未知模型 ${MODEL}`);
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const confirm = args.find((a) => a.startsWith("--confirm="))?.slice("--confirm=".length);
if (!dry && !confirm) {
  console.error("用法：--dry-run 或 --confirm=<计划哈希>（见 AGENTS.md 硬规则 1：付费评测需用户批准）");
  process.exit(2);
}
if (!dry && ["test", "demo"].includes(process.env.APP_MODE ?? "")) {
  console.error(`APP_MODE=${process.env.APP_MODE} 下禁止真实模型调用`);
  process.exit(2);
}

const reports = join(root, "tests/retrieval/reports");
const planPath = join(reports, "answer-plan.json");
const corpusSig = sha256(JSON.stringify(corpus));
const planHash = sha256(`${questionsRaw}\n${MODEL}\n${corpusSig}\n${buildPreamble()}`).slice(0, 12);

const env = await setupCorpus();
const invalid = validateQuestions(env.docText);
if (invalid.length > 0) {
  console.error(["题目自检失败：", ...invalid].join("\n"));
  await env.close();
  process.exit(2);
}

const TOK_PER_CHAR = 0.7; // 中文文本的保守估计
const FIXED_TOKENS = Math.ceil(buildPreamble().length * TOK_PER_CHAR) + 1500; // 系统提示 + 5 个工具的定义（估计）

if (dry) {
  const retrieval = new KnowledgeRetrieval(env.db);
  let inExp = 0;
  let inMax = 0;
  for (const q of questions) {
    const r = await retrieval.search(env.owner, { query: q.query, topK: 6 });
    const result = Math.ceil(r.text.length * TOK_PER_CHAR);
    const user = Math.ceil(q.query.length * TOK_PER_CHAR) + 40;
    inExp += FIXED_TOKENS + user + (FIXED_TOKENS + user + result + 200); // 2 次调用：检索、回答
    inMax += 3 * (FIXED_TOKENS + user) + Math.ceil(result * 1.5) * 2 + 600; // 上界：3 次调用，结果多 50%
  }
  const outExp = questions.length * 2 * 1500; // 推理模型：每次调用约 1500 个输出 token（含思考）
  const outMax = questions.length * 3 * 3000;
  const usd = (i: number, o: number) => (i * price.in + o * price.out) / 1e6;
  const upper = Number(usd(inMax, outMax).toFixed(3));
  const plan = {
    hash: planHash,
    model: MODEL,
    questions: questions.length,
    estimate: { input_tokens: inExp, output_tokens: outExp, usd: Number(usd(inExp, outExp).toFixed(3)) },
    upper_bound: { input_tokens: inMax, output_tokens: outMax, usd: upper },
    cap_usd: Number((upper * 1.5).toFixed(2)),
    note: "粗估：中文 0.7 token/字；每题 2 次调用，上界 3 次；输出含推理 token。真实 usage 以运行时记录为准，累计费用超过 cap_usd 即中止。",
  };
  mkdirSync(reports, { recursive: true });
  writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
  console.log(JSON.stringify(plan, null, 2));
  console.log(`\n批准后运行：EVAL_CORPUS_DIR=<语料目录> DEEPSEEK_API_KEY=… node scripts/eval-answer.ts --confirm=${planHash}`);
  await env.close();
  process.exit(0);
}

// ---- 正式运行 ----
let plan: { hash: string; cap_usd: number; upper_bound: { usd: number } };
try {
  plan = JSON.parse(readFileSync(planPath, "utf8"));
} catch {
  console.error("没有 dry-run 计划：先运行 --dry-run");
  await env.close();
  process.exit(2);
}
if (confirm !== planHash || plan.hash !== planHash) {
  console.error(`确认码与当前计划不符（当前 ${planHash}）：题目 / 模型 / 语料有变，需重新 dry-run 并获得批准`);
  await env.close();
  process.exit(2);
}
if (!process.env.DEEPSEEK_API_KEY) {
  console.error("缺少 DEEPSEEK_API_KEY");
  await env.close();
  process.exit(2);
}

const directory = new ConversationDirectory(env.db);
const retrieval = new KnowledgeRetrieval(env.db);
const pi = await startPi({
  mode: "dev",
  db: env.raw,
  extensions: [appCoreExtension(), appKnowledgeExtension({ db: env.db, conversations: directory, knowledge: env.knowledge, retrieval }), appGuardExtension({ conversations: directory })],
});
const runtime = new PiRuntime(pi, { model: { provider: "deepseek", modelId: MODEL } });
const conversations = new ConversationService(env.db, runtime, systemClock);
const validator = new CitationValidator(env.db);

type Result = {
  q: Q;
  status: string;
  searched: boolean;
  text: string;
  citations: Citation[];
  supported: boolean;
  abstained: boolean;
  excerpts: string[];
};
const results: Result[] = [];
let spent = 0;
let tokens = { input: 0, output: 0 };
const num = (v: unknown) => (typeof v === "number" ? v : 0);
async function usageNow() {
  const u = await runtime.usage();
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const m of Object.values(u.models) as Record<string, unknown>[]) {
    input += num(m.input) + num(m.cacheRead);
    output += num(m.output);
    cost += num((m.cost as Record<string, unknown> | undefined)?.total);
  }
  return { input, output, cost: cost > 0 ? cost : (input * price!.in + output * price!.out) / 1e6 };
}

for (const q of questions) {
  const conv = await conversations.get(env.owner, (await conversations.create(env.owner)).id);
  const sub = await runtime.submitInput(conv.piConversationId, { text: q.query, requestId: crypto.randomUUID(), steer: false, now: Date.now(), tz: "Asia/Shanghai" });
  const done = await runtime.waitSubmission(sub.submissionId, AbortSignal.timeout(240_000)).catch((e: Error) => ({ status: "error" as const, reason: e.name }));
  const page = await runtime.loadEarlier(conv.piConversationId, undefined, 100);
  const lastUser = page.entries.findLastIndex((e: AppEntry) => e.kind === "user");
  const mine = page.entries.slice(lastUser + 1);
  const searched = mine.some((e) => e.kind === "tool" && (e.name === "kb_search" || e.name === "kb_get_source"));
  const answer = mine.findLast((e): e is Extract<AppEntry, { kind: "assistant" }> => e.kind === "assistant" && e.text.trim() !== "");
  const citations = answer ? await validator.validate(env.owner, answer.citations ?? [], answer.markers ?? []) : [];
  const text = answer?.text ?? "";
  let supported = false;
  const excerpts: string[] = [];
  for (const c of citations) {
    if (!c.valid || c.chunkId === null) continue;
    const row = await env.db.get<{ text: string; document_id: string }>("SELECT text, document_id FROM app_chunks WHERE owner_id = ? AND id = ?", env.owner, c.chunkId);
    if (!row) continue;
    excerpts.push(`[${c.n}] ${row.text.slice(0, 300)}`);
    if (q.relevant?.some((r) => env.keyByDocId.get(row.document_id) === r.doc && squash(row.text).includes(squash(r.contains)))) supported = true;
  }
  results.push({ q, status: done.status, searched, text, citations, supported, abstained: text.includes("资料不足"), excerpts });
  const u = await usageNow();
  spent = u.cost;
  tokens = { input: u.input, output: u.output };
  console.log(`${q.id} ${done.status} searched=${searched} cites=${citations.length} abstain=${text.includes("资料不足")}  累计≈$${spent.toFixed(4)}`);
  if (spent > plan.cap_usd) {
    console.error(`累计费用 $${spent.toFixed(3)} 超过上限 $${plan.cap_usd}，中止`);
    break;
  }
}

// ---- 指标 ----
const ans = results.filter((r) => r.q.type === "answerable");
const un = results.filter((r) => r.q.type === "unanswerable");
const allCites = results.flatMap((r) => r.citations);
const validCites = allCites.filter((c) => c.valid).length;
const abstainOk = un.filter((r) => r.abstained && r.citations.length === 0).length;
const notSearched = ans.filter((r) => !r.searched).length;
const supportedN = ans.filter((r) => r.supported).length;
const falseAbstain = ans.filter((r) => r.abstained).length;
const pct = (a: number, b: number) => (b === 0 ? "n/a" : ((a / b) * 100).toFixed(1) + "%");
const day = new Date().toISOString().slice(0, 10);
const lines = [
  `# 回答评测报告 ${day}`,
  "",
  `- 模型：${MODEL}；计划哈希 ${planHash}；完成 ${results.length}/${questions.length} 题；累计 token：输入 ${tokens.input}、输出 ${tokens.output}；费用 ≈ $${spent.toFixed(4)}（估算上界 $${plan.upper_bound.usd}）。`,
  `- **引用定位有效率：${pct(validCites, allCites.length)}**（${validCites}/${allCites.length}；要求 100%）`,
  `- **无答案题的“资料不足”准确率：${pct(abstainOk, un.length)}**（${abstainOk}/${un.length}；要求 ≥9/10，且不带引用）`,
  `- 该检索时没有检索的比例（有答案题）：${pct(notSearched, ans.length)}（${notSearched}/${ans.length}）`,
  `- 有答案题中引用的片段确实包含标准答案：${pct(supportedN, ans.length)}（${supportedN}/${ans.length}）；错误地回答“资料不足”：${falseAbstain}`,
  "- 引用在语义上是否支持陈述：见人工抽查（tests/retrieval/review/，不入库）。",
  "",
  "| 题号 | 类型 | 状态 | 检索 | 引用数(有效) | 资料不足 | 命中标准答案 |",
  "|---|---|---|---|---|---|---|",
  ...results.map((r) => `| ${r.q.id} | ${r.q.type === "answerable" ? "有答案" : "无答案"} | ${r.status} | ${r.searched ? "是" : "**否**"} | ${r.citations.length}(${r.citations.filter((c) => c.valid).length}) | ${r.abstained ? "是" : "否"} | ${r.q.type === "answerable" ? (r.supported ? "是" : "**否**") : "—"} |`),
];
mkdirSync(reports, { recursive: true });
writeFileSync(join(reports, `answer-${day}.md`), lines.join("\n") + "\n");

const sample = [...ans.filter((_, i) => i % 2 === 0).slice(0, 15), ...un.slice(0, 5)];
const review = [`# 人工抽查表 ${day}（含回答与资料摘录，不入库）`, ""];
for (const r of sample) {
  review.push(`## ${r.q.id} ${r.q.query}`, "", `**回答：**\n${r.text}`, "", "**引用片段：**", ...(r.excerpts.length ? r.excerpts.map((e) => `- ${e}`) : ["- （无）"]), "");
}
mkdirSync(join(root, "tests/retrieval/review"), { recursive: true });
writeFileSync(join(root, "tests/retrieval/review", `answer-${day}.md`), review.join("\n") + "\n");
writeFileSync(join(root, "tests/retrieval/review", `answer-${day}-all.json`), JSON.stringify(results.map((r) => ({ id: r.q.id, query: r.q.query, status: r.status, text: r.text, citations: r.citations })), null, 1));

console.log(lines.slice(0, 9).join("\n"));
await pi.close();
await env.close();
process.exit(0);
