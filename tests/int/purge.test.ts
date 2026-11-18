// T-25：资料彻底删除（FR-KB-08）、purge-log、引用过资料的会话。进程内，faux，零费用。
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ConversationDirectory, ConversationService } from "../../packages/conversations/src/index.ts";
import { systemClock } from "../../packages/core/src/index.ts";
import { guardDb, migrate, type SqlDatabase } from "../../packages/db/src/index.ts";
import { BackgroundModel, JobWorker } from "../../packages/jobs/src/index.ts";
import { BlobStore, createChunkIndexer, KnowledgeRetrieval, KnowledgeService } from "../../packages/knowledge/src/index.ts";
import { appCoreExtension, appGuardExtension, appKnowledgeExtension, openAppDatabase, PiRuntime, startPi, type PiHandle } from "../../packages/runtime-pi/src/index.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../../packages/runtime-pi/src/testing/faux.ts";
import { ftsReport } from "../support/fts.ts";

let dir: string;
let db: SqlDatabase;
let pi: PiHandle;
let faux: ReturnType<typeof fauxProvider>;
let runtime: PiRuntime;
let knowledge: KnowledgeService;
let worker: JobWorker;
let conversations: ConversationService;
let logPath: string;
let blobs: BlobStore;
const O1 = "o1";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "durakeep-purge-"));
  logPath = join(dir, "purge-log.jsonl");
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  db = guardDb(raw);
  await migrate(db);
  for (const id of [O1, "o2"]) await db.run("INSERT INTO app_owners (id, display_name, timezone, created_at) VALUES (?, 'x', 'UTC', ?)", id, Date.now());
  faux = fauxProvider();
  blobs = new BlobStore(join(dir, "blobs"));
  knowledge = new KnowledgeService({
    db,
    blobs,
    clock: systemClock,
    indexer: createChunkIndexer(db),
    wake: () => worker?.wake(),
    background: new BackgroundModel(db, systemClock, () => runtime),
    purgeLogPath: logPath,
  });
  worker = new JobWorker(db, systemClock, knowledge.handlers(), { onFinished: (j) => knowledge.onJobFinished(j) });
  const retrieval = new KnowledgeRetrieval(db);
  const directory = new ConversationDirectory(db);
  pi = await startPi({ mode: "test", db: raw, faux, settings: { retry: { maxRetries: 0 } }, extensions: [appCoreExtension(), appKnowledgeExtension({ db, conversations: directory, knowledge, retrieval }), appGuardExtension({ conversations: directory })] });
  runtime = new PiRuntime(pi, { model: { provider: "faux", modelId: "faux-1" } });
  conversations = new ConversationService(db, runtime, systemClock);
  runtime.resume();
  worker.start();
});
afterEach(async () => {
  await worker.stop();
  await pi.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const TEXT = `# 彻底删除测试\n\n${Array.from({ length: 40 }, (_, i) => `第${i}条：这是一段会被检索到的独特内容喵星人专用，需要足够长才能分块。`).join("")}`;
const capture = async (owner = O1, text = TEXT, title = "要删除的资料") => {
  faux.setResponses([fauxAssistantMessage("- 摘要要点")]);
  const r = await knowledge.captureText(owner, { clientRequestId: crypto.randomUUID(), kind: "markdown", title, text });
  await worker.idle();
  return r;
};
const waitPurged = async (id: string) => {
  for (let i = 0; i < 200; i++) {
    const r = await db.get<{ status: string }>("SELECT status FROM app_documents WHERE id = ?", id);
    if (r?.status === "purged") return;
    await new Promise((x) => setTimeout(x, 25));
  }
  throw new Error("未在预期时间内 purged");
};
const one = async (sql: string, ...p: (string | number)[]) => Number(Object.values((await db.get<Record<string, unknown>>(sql, ...p))!)[0]);

test("彻底删除：立即不可检索；作业清掉片段 / FTS / 摘要 / blob；只留墓碑；purge-log 只记 ID；同样内容可以重新收藏", async () => {
  const r = await capture();
  const ver = (await db.get<{ id: string; raw_blob: string; text_blob: string }>("SELECT id, raw_blob, text_blob FROM app_document_versions WHERE document_id = ?", r.documentId))!;
  expect(blobs.has(ver.raw_blob)).toBe(true);
  expect(await one("SELECT COUNT(*) FROM app_chunks WHERE active = 1")).toBeGreaterThan(0);

  // 暂停 worker 之外的办法：先看请求返回时的“立即生效”部分——同步检查（作业此时可能已经开始，所以只断言不可检索）
  const p = await knowledge.purge(O1, r.documentId);
  expect(await one("SELECT COUNT(*) FROM app_chunks WHERE active = 1")).toBe(0);
  await waitPurged(r.documentId);

  expect(await ftsReport((s) => db.all(s))).toMatchObject({ chunks: 0, fts: 0, tri: 0 });
  const v = (await db.get<{ status: string; summary: string | null; text_blob: string | null; raw_blob: string }>("SELECT status, summary, text_blob, raw_blob FROM app_document_versions WHERE id = ?", ver.id))!;
  expect(v).toMatchObject({ status: "purged", summary: null, text_blob: null, raw_blob: "purged" });
  expect(blobs.has(ver.raw_blob)).toBe(false);
  expect(blobs.has(ver.text_blob)).toBe(false);
  const d = (await db.get<{ status: string; title: string; current_version_id: string | null; purged_at: number | null }>("SELECT status, title, current_version_id, purged_at FROM app_documents WHERE id = ?", r.documentId))!;
  expect(d).toMatchObject({ status: "purged", title: "要删除的资料", current_version_id: null });
  expect(d.purged_at).toBeGreaterThan(0);
  await expect(knowledge.detail(O1, r.documentId)).rejects.toMatchObject({ code: "not_found" });

  const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({ owner_id: O1, document_id: r.documentId, job_id: p.jobId });
  expect(JSON.stringify(lines[0])).not.toContain("要删除的资料"); // 日志只记 ID 与时间
  expect(JSON.stringify(lines[0])).not.toContain("喵星人");

  // 同样的内容可以重新收藏，是一份新资料
  const again = await capture();
  expect(again.documentId).not.toBe(r.documentId);
  expect(again.deduplicated).toBe(false);
});

test("幂等与隔离：重复删除返回同一个作业；别人的资料 404；已 purged 的 404", async () => {
  const r = await capture();
  const a = await knowledge.purge(O1, r.documentId);
  const b = await knowledge.purge(O1, r.documentId).catch((e: unknown) => e);
  if (b instanceof Error) expect(b).toMatchObject({ code: "not_found" }); // 作业已跑完
  else expect(b).toMatchObject({ jobId: a.jobId });
  await waitPurged(r.documentId);
  await expect(knowledge.purge(O1, r.documentId)).rejects.toMatchObject({ code: "not_found" });
  const other = await capture();
  await expect(knowledge.purge("o2", other.documentId)).rejects.toMatchObject({ code: "not_found" });
  expect(await one("SELECT COUNT(*) FROM app_chunks WHERE active = 1")).toBeGreaterThan(0); // 别人的删除请求没有影响到这份
});

test("摘要作业运行期间被彻底删除：摘要作业被取消、不会写回，最终仍是干净的墓碑", async () => {
  let docId = "";
  faux.setResponses([
    async () => {
      await knowledge.purge(O1, docId); // 模型“思考”期间，用户点了彻底删除
      return fauxAssistantMessage("- 不该写回的摘要");
    },
  ]);
  const r = await knowledge.captureText(O1, { clientRequestId: crypto.randomUUID(), kind: "markdown", title: "t", text: TEXT });
  docId = r.documentId;
  await waitPurged(docId);
  await worker.idle();
  expect(await one("SELECT COUNT(*) FROM app_chunks")).toBe(0);
  expect(await one("SELECT COUNT(*) FROM app_document_versions WHERE summary IS NOT NULL")).toBe(0);
  expect((await db.get<{ status: string }>("SELECT status FROM app_documents WHERE id = ?", docId))!.status).toBe("purged");
});

test("引用过这份资料的会话：kb_search / kb_get_source 的结果会被记下；彻底删除前可列出，用户可以归档", async () => {
  const r = await capture();
  const c1 = await conversations.create(O1, "问猫");
  const c2 = await conversations.create(O1, "闲聊"); // 没有检索过
  const row = (await conversations.get(O1, c1.id))!;
  faux.setResponses([fauxAssistantMessage(fauxToolCall("kb_search", { query: "喵星人" }), { stopReason: "toolUse" }), fauxAssistantMessage("好的")]);
  const s = await runtime.submitInput(row.piConversationId, { text: "查一下", requestId: crypto.randomUUID(), steer: false, now: Date.now(), tz: "UTC" });
  await runtime.waitSubmission(s.submissionId);

  const refs = await knowledge.referencingConversations(O1, r.documentId);
  expect(refs.map((x) => x.id)).toEqual([c1.id]);
  expect(refs.map((x) => x.id)).not.toContain(c2.id);
  expect(refs[0]).toMatchObject({ title: "问猫", archived: false });

  await conversations.update(O1, c1.id, { archived: true });
  expect((await knowledge.referencingConversations(O1, r.documentId))[0]).toMatchObject({ archived: true });
  expect(await knowledge.referencingConversations("o2", r.documentId)).toEqual([]); // 别人看不到

  // 删除后记录仍在（说明“这个会话曾经见过一份已删除的资料”）
  await knowledge.purge(O1, r.documentId);
  await waitPurged(r.documentId);
  expect(existsSync(logPath)).toBe(true);
  expect(await one("SELECT COUNT(*) FROM app_document_refs WHERE document_id = ?", r.documentId)).toBe(1);
});
