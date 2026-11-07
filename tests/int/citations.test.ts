// T-16：引用解析与校验。R6（回答生成期间资料被停止使用 → 引用 valid=false）；
// 伪造但真实存在的 chunk_id → valid=false（not_in_run）。端到端：Pi + faux → SSE 快照 / 条目分页。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ConversationDirectory, ConversationService, IngressService } from "../../packages/conversations/src/index.ts";
import { systemClock } from "../../packages/core/src/index.ts";
import { guardDb, migrate, type SqlDatabase } from "../../packages/db/src/index.ts";
import { JobWorker } from "../../packages/jobs/src/index.ts";
import { BlobStore, CitationValidator, createChunkIndexer, KnowledgeRetrieval, KnowledgeService } from "../../packages/knowledge/src/index.ts";
import { appCoreExtension, appGuardExtension, appKnowledgeExtension, openAppDatabase, PiRuntime, startPi, type PiHandle } from "../../packages/runtime-pi/src/index.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../../packages/runtime-pi/src/testing/faux.ts";
import { createApp } from "../../apps/server/src/app.ts";
import { SseReader } from "../support/sse.ts";

const ORIGIN = "http://127.0.0.1:4777";
const PASSWORD = "correct horse battery";
const OTHER = "other-owner";

let dir: string;
let db: SqlDatabase;
let pi: PiHandle;
let faux: ReturnType<typeof fauxProvider>;
let runtime: PiRuntime;
let knowledge: KnowledgeService;
let worker: JobWorker;
let validator: CitationValidator;
let h: ReturnType<typeof createApp>;
let cookie: string;
let ownerId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "durakeep-cite-"));
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  db = guardDb(raw);
  await migrate(db);
  knowledge = new KnowledgeService({ db, blobs: new BlobStore(join(dir, "blobs")), clock: systemClock, indexer: createChunkIndexer(db), wake: () => worker?.wake() });
  worker = new JobWorker(db, systemClock, knowledge.handlers(), { onFinished: (j) => knowledge.onJobFinished(j) });
  worker.start();
  const directory = new ConversationDirectory(db);
  faux = fauxProvider();
  pi = await startPi({
    mode: "test",
    db: raw,
    faux,
    settings: { retry: { maxRetries: 0 } },
    extensions: [appCoreExtension(), appKnowledgeExtension({ db, conversations: directory, knowledge, retrieval: new KnowledgeRetrieval(db) }), appGuardExtension({ conversations: directory })],
  });
  runtime = new PiRuntime(pi, { model: { provider: "faux", modelId: "faux-1" } });
  const conversations = new ConversationService(db, runtime, systemClock);
  validator = new CitationValidator(db);
  h = createApp({
    db,
    clock: systemClock,
    origin: ORIGIN,
    chat: { conversations, ingress: new IngressService(db, runtime, systemClock, conversations), runtime },
    knowledge,
    citations: validator,
    limits: { message: 10_000, login: 10_000 },
    sse: { keepAliveMs: 5_000 },
  });
  ownerId = (await h.auth.initOwner({ password: PASSWORD, timezone: "Asia/Shanghai" })).id;
  await db.run("INSERT INTO app_owners (id, display_name, timezone, created_at) VALUES (?, 'x', 'UTC', ?)", OTHER, Date.now());
  const login = await h.app.request("/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = /sid=[^;]+/.exec(login.headers.get("set-cookie")!)![0];
  runtime.resume();
});
afterEach(async () => {
  await worker.stop();
  await pi.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

type J = Record<string, unknown>;
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  h.app.request(path, { method, headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as J;
const sentence = (topic: string, n: number) => `${topic}的第${n}条说明：这一段内容用来验证引用校验是否按预期工作，并且保持足够的长度以便分块。`;
const body = (topic: string, n = 12) => Array.from({ length: n }, (_, i) => sentence(topic, i)).join("");
const ingest = async (text: string, title: string, owner = ownerId) => {
  const r = await knowledge.captureText(owner, { clientRequestId: crypto.randomUUID(), kind: "markdown", text, title });
  await worker.idle();
  return r;
};
const chunksOf = async (documentId: string) => (await db.all<{ id: number }>("SELECT id FROM app_chunks WHERE document_id = ? ORDER BY ordinal", documentId)).map((r) => r.id);
const call1 = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
/** 函数式响应里取工具结果 details 中的 chunk id（模型“看到”的片段）。 */
const seenIds = (ctx: unknown): number[] => [...JSON.stringify(ctx).matchAll(/"chunk_ids":\[([\d,]*)\]/g)].flatMap((m) => m[1]!.split(",").filter(Boolean).map(Number));
const answer = (text: string, ...ids: number[]) => fauxAssistantMessage(`${text}\n<citations>\n${ids.map((id, i) => `[${i + 1}] chunk:${id}`).join("\n")}\n</citations>`);

async function newConv(): Promise<string> {
  return (await json(await call("POST", "/v1/conversations", {}))).id as string;
}
async function openStream(conv: string): Promise<SseReader> {
  return new SseReader(await call("GET", `/v1/conversations/${conv}/stream`));
}
type WireEntry = { id: string; type: string; text?: string; citations?: { n: number; chunk_id: number | null; valid: boolean; invalid_reason?: string; document_id?: string; version_id?: string; title?: string; loc?: string; char_start?: number; char_end?: number }[] };
type Snap = { entries: WireEntry[]; live: { running: boolean; partialText?: string } };
/** 发一条消息，读流直到 run 结束，返回最后一条助手条目。 */
async function ask(conv: string, text: string, script: Parameters<typeof faux.setResponses>[0]): Promise<{ entry: WireEntry; snaps: Snap[] }> {
  faux.setResponses(script);
  const sse = await openStream(conv);
  await sse.nextEvent();
  const before = (await json(await call("GET", `/v1/conversations/${conv}/entries?limit=100`))).entries as WireEntry[];
  const nAssistants = before.filter((e) => e.type === "assistant").length;
  const r = await call("POST", `/v1/conversations/${conv}/messages`, { client_request_id: crypto.randomUUID(), text });
  expect(r.status).toBe(202);
  const got = await sse.until((e) => {
    if (e.event !== "snapshot") return false;
    const s = JSON.parse(e.data!) as Snap;
    return !s.live.running && s.entries.filter((x) => x.type === "assistant").length > nAssistants;
  });
  await sse.cancel();
  const snaps = got.filter((e) => e.event === "snapshot").map((e) => JSON.parse(e.data!) as Snap);
  const last = snaps.at(-1)!;
  return { entry: last.entries.filter((x) => x.type === "assistant").at(-1)!, snaps };
}
const entriesOf = async (conv: string) => ((await json(await call("GET", `/v1/conversations/${conv}/entries?limit=100`))).entries as WireEntry[]).filter((e) => e.type === "assistant");

// ------------------------------------------------------------ 校验器（DB 层）

test("校验器：七种结果——有效、不存在、别人的、已停止使用、已删除、新版本取代、这次 run 没检索过；无效的引用不泄露任何元数据", async () => {
  const a = await ingest(`# 方法\n\n${body("甲资料", 40)}`, "甲资料");
  const ids = await chunksOf(a.documentId);
  const theirs = await ingest(body("对方资料", 4), "对方资料", OTHER);
  const theirChunk = (await chunksOf(theirs.documentId))[0]!;
  const raw = (n: number, chunkId: number | null, inRun = true) => ({ n, chunkId, inRun });

  const r = await validator.validate(ownerId, [raw(1, ids[0]!), raw(2, 99_999_999), raw(3, theirChunk), raw(4, ids[1]!, false), raw(5, null)], [1, 2, 3, 4, 5, 6]);
  const by = (n: number) => r.find((c) => c.n === n)!;
  expect(by(1)).toMatchObject({ valid: true, documentId: a.documentId, title: "甲资料", loc: "方法" });
  expect(typeof by(1).versionId).toBe("string");
  const row = (await db.get<{ char_start: number; char_end: number }>("SELECT char_start, char_end FROM app_chunks WHERE id = ?", ids[0]!))!;
  expect([by(1).charStart, by(1).charEnd]).toEqual([row.char_start, row.char_end]); // 字符区间（FR-KB-05）
  expect(by(2)).toEqual({ n: 2, chunkId: 99_999_999, valid: false, invalidReason: "missing" });
  expect(by(3)).toEqual({ n: 3, chunkId: theirChunk, valid: false, invalidReason: "missing" }); // 别人的 = 不存在，不区分
  expect(by(4)).toEqual({ n: 4, chunkId: ids[1], valid: false, invalidReason: "not_in_run" }); // 真实存在，但模型没检索过
  expect(by(5)).toEqual({ n: 5, chunkId: null, valid: false, invalidReason: "missing" }); // 无法解析的行
  expect(by(6)).toEqual({ n: 6, chunkId: null, valid: false, invalidReason: "unresolved" }); // 正文有 [6]，没有对应条目
  expect(r.map((c) => c.n)).toEqual([1, 2, 3, 4, 5, 6]);
  for (const c of r.filter((x) => !x.valid)) expect(Object.keys(c).sort()).toEqual(["chunkId", "invalidReason", "n", "valid"]);

  // 停止使用 / 恢复：立即生效、可撤销
  await knowledge.revoke(ownerId, a.documentId);
  expect((await validator.validate(ownerId, [raw(1, ids[0]!)]))[0]).toMatchObject({ valid: false, invalidReason: "revoked" });
  await knowledge.restore(ownerId, a.documentId);
  expect((await validator.validate(ownerId, [raw(1, ids[0]!)]))[0]!.valid).toBe(true);

  // 已删除 / 正在删除
  await db.run("UPDATE app_documents SET status = 'purging' WHERE id = ?", a.documentId);
  expect((await validator.validate(ownerId, [raw(1, ids[0]!)]))[0]).toMatchObject({ valid: false, invalidReason: "purged" });
  await db.run("UPDATE app_documents SET status = 'purged' WHERE id = ?", a.documentId);
  expect((await validator.validate(ownerId, [raw(1, ids[0]!)]))[0]).toMatchObject({ valid: false, invalidReason: "purged" });
  await db.run("UPDATE app_documents SET status = 'ready' WHERE id = ?", a.documentId);

  // 新版本取代：当前版本换了，旧版本的片段不再有效
  await db.run("UPDATE app_documents SET current_version_id = 'some-newer-version' WHERE id = ?", a.documentId);
  expect((await validator.validate(ownerId, [raw(1, ids[0]!)]))[0]).toMatchObject({ valid: false, invalidReason: "superseded" });
});

test("没有引用也没有标记 → 空；多个引用只查一次库的结果一致；同一 chunk 被两个编号引用都有效", async () => {
  expect(await validator.validate(ownerId, [], [])).toEqual([]);
  const a = await ingest(body("共用", 6), "共用");
  const id = (await chunksOf(a.documentId))[0]!;
  const r = await validator.validate(ownerId, [{ n: 1, chunkId: id, inRun: true }, { n: 2, chunkId: id, inRun: true }], [1, 2]);
  expect(r.map((c) => c.valid)).toEqual([true, true]);
});

// ------------------------------------------------------------ 端到端（Pi + faux + SSE）

test("正常回答：引用被解析、校验通过，快照里带定位信息；可见正文里没有 <citations> 块", async () => {
  const a = await ingest(`# 间隔重复\n\n${body("遗忘曲线", 10)}`, "间隔重复笔记");
  const conv = await newConv();
  const { entry } = await ask(conv, "遗忘曲线说了什么？", [
    call1("kb_search", { query: "遗忘曲线" }),
    (ctx) => answer("遗忘曲线描述了记忆随时间衰减 [1]。", seenIds(ctx)[0]!),
  ]);
  expect(entry.text).toBe("遗忘曲线描述了记忆随时间衰减 [1]。");
  expect(entry.text).not.toContain("<citations");
  expect(entry.citations).toHaveLength(1);
  const c = entry.citations![0]!;
  expect(c).toMatchObject({ n: 1, valid: true, document_id: a.documentId, title: "间隔重复笔记", loc: "间隔重复" });
  expect(typeof c.chunk_id).toBe("number");
  expect(c.char_end! > c.char_start!).toBe(true);
  // 条目分页接口给出同样的结果
  expect((await entriesOf(conv)).at(-1)!.citations![0]).toEqual(c);
});

test("R6：回答生成期间资料被停止使用 → 最终快照里引用 valid=false（revoked）；恢复使用后重新展示又变回有效", async () => {
  const a = await ingest(body("会被停用的话题", 10), "会被停用");
  const conv = await newConv();
  const { entry, snaps } = await ask(conv, "说说看", [
    call1("kb_search", { query: "会被停用的话题" }),
    async (ctx) => {
      const id = seenIds(ctx)[0]!;
      await knowledge.revoke(ownerId, a.documentId); // 模型正在生成回答时，用户停止使用了这份资料
      return answer("它是这样的 [1]。", id);
    },
  ]);
  expect(entry.citations![0]).toMatchObject({ n: 1, valid: false, invalid_reason: "revoked" });
  expect(entry.citations![0]).not.toHaveProperty("title"); // 无效的引用不展示资料信息，也不提供跳转
  expect(snaps.at(-1)!.live.running).toBe(false);
  // 此后检索也搜不到它了
  expect((await entriesOf(conv)).at(-1)!.citations![0]!.valid).toBe(false);
  // 恢复使用：校验是在展示时做的，所以重新展示就恢复有效
  await knowledge.restore(ownerId, a.documentId);
  expect((await entriesOf(conv)).at(-1)!.citations![0]).toMatchObject({ valid: true, title: "会被停用" });
  // 回答之后再停止使用：同样立即变红
  await knowledge.revoke(ownerId, a.documentId);
  const sse = await openStream(conv);
  const first = JSON.parse((await sse.nextEvent()).data!) as Snap;
  await sse.cancel();
  expect(first.entries.filter((e) => e.type === "assistant").at(-1)!.citations![0]).toMatchObject({ valid: false, invalid_reason: "revoked" });
});

test("DoD：伪造但真实存在的 chunk_id → valid=false（not_in_run）；同一回答里真实检索到的引用仍然有效", async () => {
  await ingest(`${body("苹果树嫁接", 8)}`, "被检索的");
  const decoy = await ingest(`${body("量子纠缠", 8)}`, "诱饵"); // 存在、属于当前 owner、active=1，但本次 run 没有检索到
  const decoyChunk = (await chunksOf(decoy.documentId))[0]!;
  const conv = await newConv();
  const { entry } = await ask(conv, "问一个问题", [
    call1("kb_search", { query: "苹果树嫁接" }),
    (ctx) => answer("真实内容 [1]，凭空编造的内容 [2]。", seenIds(ctx)[0]!, decoyChunk),
  ]);
  const [c1, c2] = entry.citations!;
  expect(c1).toMatchObject({ n: 1, valid: true, title: "被检索的" });
  expect(c2).toMatchObject({ n: 2, chunk_id: decoyChunk, valid: false, invalid_reason: "not_in_run" });
  expect(c2).not.toHaveProperty("title");
});

test("run 的范围：上一个 run 里检索到的片段，在下一个 run 里不检索就引用 → not_in_run", async () => {
  const a = await ingest(body("跨轮话题", 8), "跨轮");
  const conv = await newConv();
  let first = 0;
  await ask(conv, "第一问", [call1("kb_search", { query: "跨轮话题" }), (ctx) => { first = seenIds(ctx)[0]!; return answer("第一轮 [1]。", first); }]);
  expect(first).toBeGreaterThan(0);
  const { entry } = await ask(conv, "第二问", [answer("第二轮没有检索，直接引用上一轮的片段 [1]。", first)]);
  expect(entry.citations![0]).toMatchObject({ n: 1, chunk_id: first, valid: false, invalid_reason: "not_in_run" });
  expect(a.documentId).toBeTruthy();
});

test("kb_get_source 取到的相邻片段、被合并命中里的非代表片段，都算“这次 run 里见过”", async () => {
  const a = await ingest(`# 长文\n\n${body("相邻命中", 120)}`, "长文");
  const ids = await chunksOf(a.documentId);
  expect(ids.length).toBeGreaterThan(5);
  const conv = await newConv();
  const { entry } = await ask(conv, "展开一下", [
    call1("kb_get_source", { chunk_id: ids[2]!, expand: 2 }), // 返回 ids[0..4]
    answer("引用了展开的相邻片段 [1][2]。", ids[0]!, ids[4]!),
  ]);
  expect(entry.citations!.map((c) => [c.chunk_id, c.valid])).toEqual([[ids[0], true], [ids[4], true]]);
  // 合并命中：kb_search 的 details.chunk_ids 含全部被合并的片段
  const conv2 = await newConv();
  let all: number[] = [];
  const { entry: e2 } = await ask(conv2, "搜一下", [
    call1("kb_search", { query: "说明", top_k: 3 }),
    (ctx) => { all = seenIds(ctx); return answer("引用每一个出现过的片段。", ...all.slice(0, 4)); },
  ]);
  expect(all.length).toBeGreaterThanOrEqual(2);
  expect(e2.citations!.every((c) => c.valid)).toBe(true);
});

test("别人的 chunk id、不存在的 id、无法解析的行、正文里有 [n] 却没有引用条目 → 全部标红；别人的与不存在的原因相同", async () => {
  await ingest(body("我的话题", 6), "我的");
  const theirs = await ingest(body("对方的话题", 6), "对方", OTHER);
  const theirChunk = (await chunksOf(theirs.documentId))[0]!;
  const conv = await newConv();
  faux.setResponses([call1("kb_search", { query: "我的话题" }), fauxAssistantMessage(`看对方的 [1]，看不存在的 [2]，看格式不对的 [3]，还有没列出来的 [4]。\n<citations>\n[1] chunk:${theirChunk}\n[2] chunk:99999999\n[3] 第三章第二节\n</citations>`)]);
  const sse = await openStream(conv);
  await sse.nextEvent();
  await call("POST", `/v1/conversations/${conv}/messages`, { client_request_id: crypto.randomUUID(), text: "试试" });
  const got = await sse.until((e) => e.event === "snapshot" && !(JSON.parse(e.data!) as Snap).live.running && (JSON.parse(e.data!) as Snap).entries.some((x) => x.type === "assistant"));
  await sse.cancel();
  const cs = (JSON.parse(got.at(-1)!.data!) as Snap).entries.filter((x) => x.type === "assistant").at(-1)!.citations!;
  expect(cs.map((c) => [c.n, c.valid, c.invalid_reason])).toEqual([
    [1, false, "missing"],
    [2, false, "missing"],
    [3, false, "missing"],
    [4, false, "unresolved"],
  ]);
  expect(JSON.stringify(cs)).not.toContain("对方"); // 没有泄露别人资料的任何信息
});
