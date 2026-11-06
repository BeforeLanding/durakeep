// T-14：分块入库、两张 FTS 表、不变式 2、检索（词法 / 子串）、停止使用与恢复、版本切换、可续写、性能。
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeClock } from "../../packages/core/src/index.ts";
import { guardDb, migrate, type SqlDatabase } from "../../packages/db/src/index.ts";
import { JobWorker } from "../../packages/jobs/src/index.ts";
import {
  BlobStore,
  chunkMarkdown,
  createChunkIndexer,
  KnowledgeService,
  searchLexical,
  searchSubstring,
  setActiveChunks,
  type FetchPolicy,
} from "../../packages/knowledge/src/index.ts";
import { openAppDatabase } from "../../packages/runtime-pi/src/index.ts";
import { ftsConsistent, ftsReport } from "../support/fts.ts";

const OWNER = "o1";
let dir: string;
let db: SqlDatabase;
let closeDb: () => Promise<void>;
let clock: FakeClock;
let knowledge: KnowledgeService;
let worker: JobWorker;
let policy: Partial<FetchPolicy>;
const servers: Server[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "durakeep-idx-"));
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  closeDb = () => raw.close();
  db = guardDb(raw);
  await migrate(db);
  clock = new FakeClock(Date.UTC(2026, 10, 6, 7, 0));
  policy = { isPublicIp: (ip) => ip === "127.0.0.1", resolve: async (h) => (h.endsWith(".test") ? ["127.0.0.1"] : Promise.reject(new Error("ENOTFOUND"))) };
  knowledge = new KnowledgeService({ db, blobs: new BlobStore(join(dir, "blobs")), clock, fetchPolicy: policy, indexer: createChunkIndexer(db), wake: () => worker?.wake() });
  worker = new JobWorker(db, clock, knowledge.handlers(), { onFinished: (j) => knowledge.onJobFinished(j) });
  worker.start();
  for (const id of [OWNER, "o2"]) await db.run("INSERT INTO app_owners (id, display_name, timezone, created_at) VALUES (?, 'x', 'UTC', ?)", id, Date.now());
});
afterEach(async () => {
  await worker.stop();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  await closeDb();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const crid = () => crypto.randomUUID();
const sentence = (topic: string, n: number) => `${topic}相关的第${n}条说明：这一段内容用来验证分块与检索是否按预期工作，并且保持足够的长度。`;
const body = (topic: string, sentences = 30) => Array.from({ length: sentences }, (_, i) => sentence(topic, i)).join("");
const ingest = async (text: string, extra: { title?: string; tags?: string[]; owner?: string } = {}) => {
  const r = await knowledge.captureText(extra.owner ?? OWNER, { clientRequestId: crid(), kind: "markdown", text, title: extra.title, tags: extra.tags });
  await worker.idle();
  return r;
};
const report = () => ftsReport((sql) => db.all(sql));
const lex = (q: string, o?: Parameters<typeof searchLexical>[3], owner = OWNER) => searchLexical(db, owner, q, o);
const sub = (q: string, o?: Parameters<typeof searchSubstring>[3], owner = OWNER) => searchSubstring(db, owner, q, o);

test("入库：块写入 app_chunks 与两张 FTS 表（不变式 2）；块文本与正文 blob 的字符区间逐个相等；版本 parser_version 带 +chunk1", async () => {
  const text = `# 间隔重复\n\n${body("遗忘曲线", 120)}\n\n## 方法\n\n${body("复习间隔", 120)}`;
  const r = await ingest(text, { title: "间隔重复笔记" });
  const { document, versions } = await knowledge.detail(OWNER, r.documentId);
  expect(document.status).toBe("ready");
  expect(versions[0]!.parserVersion).toBe("markdown@1+chunk1");
  const stored = await knowledge.readText(OWNER, r.documentId, versions[0]!.id);
  const chunks = await db.all<{ ordinal: number; heading_path: string; char_start: number; char_end: number; text: string; active: number; token_estimate: number }>(
    "SELECT ordinal, heading_path, char_start, char_end, text, active, token_estimate FROM app_chunks WHERE version_id = ? ORDER BY ordinal",
    versions[0]!.id,
  );
  expect(chunks.length).toBeGreaterThan(4);
  expect(chunks.length).toBe(chunkMarkdown(stored).length); // 与纯函数的结果一致
  for (const c of chunks) {
    expect(stored.slice(c.char_start, c.char_end)).toBe(c.text); // 引用校验会依赖这一点（FR-KB-05）
    expect(c.active).toBe(1);
    expect(c.token_estimate).toBeGreaterThan(0);
  }
  expect([...new Set(chunks.map((c) => c.heading_path))]).toEqual(["间隔重复", "间隔重复 > 方法"]);
  const rep = await report();
  expect(ftsConsistent(rep), JSON.stringify(rep)).toBe(true);
  expect(rep.chunks).toBe(chunks.length);
});

test("词法路：两字词能搜到；命中的是对的块；没有的词、全是停用词的查询返回空；大小写与全角不敏感", async () => {
  await ingest(`# 笔记\n\n${body("遗忘曲线", 90)}`, { title: "A" });
  await ingest(`# English\n\nSQLite is an embedded database engine. ${body("数据库", 12)}`, { title: "B" });
  const forget = await lex("遗忘");
  expect(forget.length).toBeGreaterThan(0);
  expect(forget.every((h) => h.text.includes("遗忘"))).toBe(true);
  expect((await lex("宇宙飞船")).length).toBe(0); // 没有任何词命中
  expect((await lex("宇宙飞船 星际旅行")).length).toBe(0);
  expect((await lex("的 了 是")).length).toBe(0); // 全是停用词
  expect((await lex("")).length).toBe(0);
  expect((await lex("sqlite")).length).toBeGreaterThan(0);
  expect((await lex("ＳＱＬｉｔｅ")).length).toBeGreaterThan(0);
  expect(await lex("遗忘", { limit: 3 })).toHaveLength(3);
  // FTS5 的运算符被当成普通文本，不会让查询报语法错误
  for (const evil of ['遗忘" OR "x', "NEAR(a b)", "a AND", "*", '"', "遗忘 -曲线", "col:遗忘"]) await expect(lex(evil)).resolves.toBeDefined();
});

test("标题列权重：词出现在标题路径里的块排在只在正文里出现的块之前", async () => {
  await ingest(`# 无关标题\n\n${body("无关", 6)}量子计算只在这一句里被提到一次，其余都是别的内容。${body("填充", 10)}`, { title: "正文命中" });
  await ingest(`# 量子计算\n\n${body("引言", 6)}`, { title: "标题命中" });
  const hits = await lex("量子计算", { limit: 5 });
  expect(hits.length).toBeGreaterThanOrEqual(2);
  expect(hits[0]!.headingPath).toBe("量子计算");
});

test("子串路：分词切错的子串用 trigram 召回；两个字符以内不执行", async () => {
  await ingest(`${body("遗忘曲线", 15)}`);
  const hits = await sub("忘曲线");
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.every((h) => h.text.includes("忘曲线"))).toBe(true);
  expect(await sub("遗忘")).toEqual([]); // 只有 2 个字符
  expect(await sub("宇宙飞船")).toEqual([]);
  expect((await sub("SQLITE")).length).toBe(0);
  await ingest("SQLite is an embedded database. " + body("数据库", 10));
  expect((await sub("sqlite")).length).toBeGreaterThan(0); // trigram 不区分大小写
});

test("过滤：owner 隔离；标签过滤；块的 owner_id 来自资料所有者", async () => {
  await ingest(body("共同话题", 12), { title: "我的", tags: ["学习", "笔记"] });
  await ingest(body("共同话题", 12) + "甲方独有词汇铂铱合金。", { title: "别人的", owner: "o2", tags: ["学习"] });
  const mine = await lex("共同话题");
  expect(mine.length).toBeGreaterThan(0);
  const docs = await db.all<{ id: string; owner_id: string }>("SELECT id, owner_id FROM app_documents");
  for (const h of mine) expect(docs.find((d) => d.id === h.documentId)!.owner_id).toBe(OWNER);
  expect((await lex("铂铱合金")).length).toBe(0); // 别人的内容搜不到
  expect((await lex("铂铱合金", {}, "o2")).length).toBeGreaterThan(0);
  expect((await lex("共同话题", { tag: "笔记" })).length).toBeGreaterThan(0);
  expect((await lex("共同话题", { tag: "不存在的标签" })).length).toBe(0);
  expect((await sub("共同话题", { tag: "笔记" })).length).toBeGreaterThan(0);
  expect((await sub("共同话题", { tag: "不存在的标签" })).length).toBe(0);
  // 子串路同样隔离
  expect((await sub("铂铱合金")).length).toBe(0);
  expect((await sub("铂铱合金", {}, "o2")).length).toBeGreaterThan(0);
});

test("停止使用立即生效、恢复后重新可搜；两张 FTS 表始终一致（不变式 2）", async () => {
  const r = await ingest(body("可撤销话题", 15));
  expect((await lex("可撤销话题")).length).toBeGreaterThan(0);
  expect((await sub("可撤销话题")).length).toBeGreaterThan(0);
  await knowledge.revoke(OWNER, r.documentId);
  expect(await lex("可撤销话题")).toEqual([]);
  expect(await sub("可撤销话题")).toEqual([]);
  expect((await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_chunks WHERE active = 1"))!.c).toBe(0);
  expect(ftsConsistent(await report())).toBe(true);
  await knowledge.restore(OWNER, r.documentId);
  expect((await lex("可撤销话题")).length).toBeGreaterThan(0);
  expect((await sub("可撤销话题")).length).toBeGreaterThan(0);
  expect(ftsConsistent(await report())).toBe(true);
  // 在“已停止使用”状态下又完成了一次新版本的索引：块保持不可检索（用户的决定优先）
  await knowledge.revoke(OWNER, r.documentId);
  const n = (await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_chunks WHERE active = 1"))!.c;
  expect(n).toBe(0);
});

async function site(handler: (url: string) => string) {
  const s = createServer((req, res) => {
    if (req.url === "/robots.txt") { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(handler(req.url ?? "/"));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
}
const page = (topic: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${topic}页</title></head><body><article><h1>${topic}页</h1><p>${body(topic, 14)}</p></article></body></html>`;

test("新版本：旧版本的块保留但不再可检索；内容变回旧版本时旧块重新可检索；FTS 始终一致", async () => {
  let current = "阿尔法";
  const port = await site(() => page(current));
  const url = `http://v.test:${port}/p`;
  const first = await knowledge.captureUrl(OWNER, { clientRequestId: crid(), url });
  await worker.idle();
  expect((await lex("阿尔法")).length).toBeGreaterThan(0);

  current = "贝塔";
  clock.advance(24 * 3600 * 1000);
  await knowledge.captureUrl(OWNER, { clientRequestId: crid(), url });
  await worker.idle();
  expect((await knowledge.detail(OWNER, first.documentId)).versions).toHaveLength(2);
  expect(await lex("阿尔法")).toEqual([]); // 旧版本不再被搜到
  expect((await lex("贝塔")).length).toBeGreaterThan(0);
  const byVersion = await db.all<{ version_id: string; active: number; c: number }>("SELECT version_id, active, COUNT(*) AS c FROM app_chunks GROUP BY version_id, active");
  expect(byVersion).toHaveLength(2); // 两个版本都有块：一个 active、一个 inactive
  expect(new Set(byVersion.map((b) => b.active))).toEqual(new Set([0, 1]));
  expect(ftsConsistent(await report())).toBe(true);

  current = "阿尔法";
  clock.advance(24 * 3600 * 1000);
  await knowledge.captureUrl(OWNER, { clientRequestId: crid(), url });
  await worker.idle();
  expect((await lex("阿尔法")).length).toBeGreaterThan(0); // 内容回到旧版本：旧块重新可检索
  expect(await lex("贝塔")).toEqual([]);
  expect((await knowledge.detail(OWNER, first.documentId)).versions).toHaveLength(2); // 没有产生第三个版本
  expect(ftsConsistent(await report())).toBe(true);
});

async function syntheticVersion(text: string) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await db.run("INSERT INTO app_documents (id, owner_id, source_type, title, status, created_at, updated_at) VALUES (?, ?, 'text', 't', 'ready', ?, ?)", id, OWNER, now, now);
  await db.run("INSERT INTO app_document_versions (id, document_id, owner_id, content_hash, raw_blob, parser_version, status, captured_at) VALUES (?, ?, ?, ?, ?, 'x', 'indexing', ?)", `v-${id}`, id, OWNER, id, id, now);
  return { documentId: id, versionId: `v-${id}`, ownerId: OWNER, text };
}

test("可续写：批次中途失败后重试只补写缺的块、不产生重复；正文变了则整版重建；再次调用是幂等的", async () => {
  const v = await syntheticVersion(`# 长文\n\n${body("续写测试", 700)}`);
  const total = chunkMarkdown(v.text).length;
  expect(total).toBeGreaterThan(30);
  // 第 3 次事务失败（= 第 3 批写不进去）：前 2 批已提交
  let txCount = 0;
  const flaky: SqlDatabase = { ...db, transaction: (cb) => (++txCount === 3 ? Promise.reject(new Error("disk hiccup")) : db.transaction(cb)) };
  await expect(createChunkIndexer(flaky, { batchSize: 10 })(v)).rejects.toThrow("disk hiccup");
  const partial = (await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_chunks WHERE version_id = ?", v.versionId))!.c;
  expect(partial).toBe(20);
  expect(ftsConsistent(await report())).toBe(true); // 半途而废的状态也是一致的：块与 FTS 行成对写入
  expect((await lex("续写测试")).length).toBe(0); // 半成品不可检索（写入时 active=0）

  const indexer = createChunkIndexer(db, { batchSize: 10 });
  await indexer(v);
  expect((await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_chunks WHERE version_id = ?", v.versionId))!.c).toBe(total);
  expect(ftsConsistent(await report())).toBe(true);
  const ords = (await db.all<{ ordinal: number }>("SELECT ordinal FROM app_chunks WHERE version_id = ? ORDER BY ordinal", v.versionId)).map((r) => r.ordinal);
  expect(ords).toEqual(Array.from({ length: total }, (_, i) => i)); // 序号连续、无重复

  await indexer(v); // 幂等
  expect((await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_chunks"))!.c).toBe(total);

  // 正文变了：已有的块不是新分块结果的前缀 → 整版重建
  const changed = { ...v, text: `# 长文\n\n${body("另一份内容", 300)}` };
  await indexer(changed);
  const newTotal = chunkMarkdown(changed.text).length;
  expect((await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_chunks"))!.c).toBe(newTotal);
  expect(ftsConsistent(await report())).toBe(true);
  await setActiveChunks(db, OWNER, v.documentId, v.versionId, true);
  expect((await lex("另一份内容")).length).toBeGreaterThan(0);
  expect((await lex("续写测试")).length).toBe(0);
});

test("分批：每批一个事务；批与批之间让出事件循环；单批耗时远低于对话提交可容忍的范围", async () => {
  const v = await syntheticVersion(body("分批测试", 700));
  const total = chunkMarkdown(v.text).length;
  const durations: number[] = [];
  // 并发的探针：只要索引器在批次之间让出事件循环，它就能跑起来
  let probe = 0;
  let running = true;
  const loop = () => {
    if (!running) return;
    probe++;
    setImmediate(loop);
  };
  setImmediate(loop);
  const timed: SqlDatabase = {
    ...db,
    transaction: async (cb) => {
      const t0 = performance.now();
      const r = await db.transaction(cb);
      durations.push(performance.now() - t0);
      return r;
    },
  };
  await createChunkIndexer(timed, { batchSize: 5 })(v);
  running = false;
  const batches = durations.length;
  expect(batches).toBe(Math.ceil(total / 5));
  const max = Math.max(...durations);
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
  console.log(`[T-14 分批] ${total} 块 / ${durations.length} 批，单批（5 块）耗时 平均 ${mean.toFixed(1)}ms 最大 ${max.toFixed(1)}ms，探针 ${probe} 次`);
  expect(max).toBeLessThan(250); // ADR-02：每批控制在 50ms 左右，这里留足余量避免偶发抖动
  expect(probe).toBeGreaterThanOrEqual(batches); // 每批之间都让出过事件循环
});

test("性能（DoD）：1 万个片段时检索 p95 ≤ 300 ms（词法 + 子串两路合计）", async () => {
  // 词表：8000 个 2–4 字的“词”，按齐夫分布取样，使高频词命中成千上万个块，低频词命中很少
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const chars = "的一是不了人我在有他这中大来上国个到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分将外但身些与高意进把法此实回二理美点月明其种声全工己话儿者向情部正名定女问力机给等几很业最间新什打便位因重被走电四第门相次东政海口使教西再平真听世气信北少关并内加化由却代军产入先山无书合万记千";
  const pickWord = () => {
    const r = rnd();
    const rank = Math.floor(8000 * r * r * r); // 偏向小编号 = 高频词
    let x = rank + 1;
    const len = 2 + (rank % 3);
    let w = "";
    for (let i = 0; i < len; i++) {
      w += chars[x % chars.length];
      x = Math.floor(x / chars.length) + (i + 3) * 7;
    }
    return w;
  };
  const DOCS = 100;
  const CHUNKS_PER_DOC = 100;
  const indexer = createChunkIndexer(db, { batchSize: 50 });
  const t0 = performance.now();
  const sample: string[] = [];
  for (let d = 0; d < DOCS; d++) {
    // 每块约 650 字符：把句子拼到够长，用 “。” 结尾，段落之间空行
    const paras: string[] = [];
    for (let p = 0; p < CHUNKS_PER_DOC; p++) {
      let para = "";
      while (para.length < 640) {
        let s = "";
        const n = 6 + Math.floor(rnd() * 10);
        for (let i = 0; i < n; i++) s += pickWord();
        para += s + "。";
      }
      paras.push(para);
      if (p % 40 === 0) sample.push(para);
    }
    const text = `# 文档${d}\n\n${paras.join("\n\n")}`;
    const v = await syntheticVersion(text);
    await indexer(v);
    await setActiveChunks(db, OWNER, v.documentId, v.versionId, true);
  }
  const indexMs = performance.now() - t0;
  const n = (await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_chunks WHERE active = 1"))!.c;
  console.log(`[T-14 性能] 索引 ${n} 个片段用时 ${(indexMs / 1000).toFixed(1)}s`);
  expect(n).toBeGreaterThanOrEqual(10_000);
  expect(ftsConsistent(await report())).toBe(true);

  // 查询：1–3 个词（词法）+ 来自文本的 3–6 字片段（子串）
  const latencies: number[] = [];
  const lexOnly: number[] = [];
  const subOnly: number[] = [];
  let withHits = 0;
  for (let i = 0; i < 300; i++) {
    const words = Array.from({ length: 1 + (i % 3) }, pickWord).join("");
    const src = sample[i % sample.length]!;
    const from = Math.floor(rnd() * (src.length - 8));
    const frag = src.slice(from, from + 3 + (i % 4));
    const q = `${words}${frag}`;
    const t = performance.now();
    const a = await searchLexical(db, OWNER, q, { limit: 20 });
    const t1 = performance.now();
    const b = await searchSubstring(db, OWNER, q, { limit: 20 });
    const t2 = performance.now();
    lexOnly.push(t1 - t);
    subOnly.push(t2 - t1);
    latencies.push(t2 - t);
    if (a.length + b.length > 0) withHits++;
  }
  const p = (xs: number[], q: number) => [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.ceil(xs.length * q) - 1)]!;
  console.log(
    `[T-14 性能] ${n} 片段，300 次查询：合计 p50=${p(latencies, 0.5).toFixed(1)}ms p95=${p(latencies, 0.95).toFixed(1)}ms max=${Math.max(...latencies).toFixed(1)}ms；` +
      `词法 p95=${p(lexOnly, 0.95).toFixed(1)}ms 子串 p95=${p(subOnly, 0.95).toFixed(1)}ms；有命中 ${withHits}/300`,
  );
  expect(withHits).toBeGreaterThan(150); // 查询确实能命中东西，不是在测空查询
  expect(p(latencies, 0.95)).toBeLessThanOrEqual(300);
}, 300_000);
