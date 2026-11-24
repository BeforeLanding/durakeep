// T-19：GET /v1/export 的结构，以及 S11——日志和导出包里检索不到消息正文、口令（哈希）和 API key。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ConversationService, IngressService } from "../../packages/conversations/src/index.ts";
import { FakeClock, systemClock } from "../../packages/core/src/index.ts";
import { guardDb, migrate, type SqlDatabase } from "../../packages/db/src/index.ts";
import { JobWorker } from "../../packages/jobs/src/index.ts";
import { BlobStore, createChunkIndexer, KnowledgeService } from "../../packages/knowledge/src/index.ts";
import { MemoryService } from "../../packages/memory/src/index.ts";
import { ReminderService, Scheduler } from "../../packages/reminders/src/index.ts";
import { openAppDatabase, PiRuntime, startPi, type PiHandle } from "../../packages/runtime-pi/src/index.ts";
import { fauxAssistantMessage, fauxProvider } from "../../packages/runtime-pi/src/testing/faux.ts";
import { createApp, type LogEvent } from "../../apps/server/src/app.ts";

const ORIGIN = "http://127.0.0.1:4777";
const PASSWORD = "correct horse battery";
const API_KEY = "sk-test-sentinel-9f3a1c77d2e84b";
const MESSAGE = "这是一条绝不该出现在日志或导出包里的消息正文-QX93";

let dir: string;
let db: SqlDatabase;
let pi: PiHandle;
let worker: JobWorker;
let h: ReturnType<typeof createApp>;
let cookie: string;
let logs: LogEvent[];
let runtime: PiRuntime;
let ownerId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "durakeep-export-"));
  const faux = fauxProvider();
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  db = guardDb(raw);
  await migrate(db);
  pi = await startPi({ mode: "test", db: raw, faux, settings: { retry: { maxRetries: 0 } } });
  faux.setResponses([fauxAssistantMessage("收到。")]);
  runtime = new PiRuntime(pi, { model: { provider: "faux", modelId: "faux-1" } });
  const knowledge = new KnowledgeService({ db, blobs: new BlobStore(join(dir, "blobs")), clock: systemClock, indexer: createChunkIndexer(db), wake: () => worker?.wake() });
  worker = new JobWorker(db, systemClock, knowledge.handlers(), { onFinished: (j) => knowledge.onJobFinished(j) });
  worker.start();
  const conversations = new ConversationService(db, runtime, systemClock);
  const ingress = new IngressService(db, runtime, systemClock, conversations);
  logs = [];
  h = createApp({ db, clock: systemClock, origin: ORIGIN, chat: { conversations, ingress, runtime }, knowledge, wakeJobs: () => worker.wake(), limits: { login: 10_000 }, log: (e) => logs.push(e) });
  ownerId = (await h.auth.initOwner({ password: PASSWORD, timezone: "Asia/Shanghai" })).id;
  const login = await h.app.request("/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ password: PASSWORD }) });
  cookie = /sid=[^;]+/.exec(login.headers.get("set-cookie")!)![0];
  runtime.resume();
  process.env.DEEPSEEK_API_KEY = API_KEY;
});
afterEach(async () => {
  delete process.env.DEEPSEEK_API_KEY;
  await worker.stop();
  await pi.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const call = (method: string, path: string, body?: unknown) =>
  h.app.request(path, { method, headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

/** 导出用 ZIP 的存储方式，按本地文件头读取内容。 */
function zipFiles(buf: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (buf.readUInt32LE(offset) === 0x04034b50) {
    const size = buf.readUInt32LE(offset + 18);
    const nameStart = offset + 30;
    const nameEnd = nameStart + buf.readUInt16LE(offset + 26);
    const dataStart = nameEnd + buf.readUInt16LE(offset + 28);
    entries.set(buf.toString("utf8", nameStart, nameEnd), buf.subarray(dataStart, dataStart + size));
    offset = dataStart + size;
  }
  return entries;
}

test("导出包结构：manifest + 每个版本的 meta.json / text.md / raw；不含认证、会话、幂等与 pi_ 表", async () => {
  const r = await call("POST", "/v1/documents", { client_request_id: crypto.randomUUID(), type: "markdown", text: "# 导出样例\n\n正文内容。", tags: ["t"] });
  expect(r.status).toBe(202);
  await worker.idle();
  const res = await call("GET", "/v1/export");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="export-\d{8}T\d{6}\.zip"$/);
  const buf = Buffer.from(await res.arrayBuffer());
  const names = [...zipFiles(buf).keys()];
  expect(names[0]).toBe("manifest.json");
  expect(names.filter((n) => n.startsWith("documents/")).map((n) => n.split("/").pop()).sort()).toEqual(["meta.json", "raw.md", "text.md"]);
  expect(names.join("\n")).not.toMatch(/app_auth|app_sessions|app_operations|app_events|pi_/);
  expect(buf.includes(Buffer.from("正文内容。"))).toBe(true); // 资料正文本就应该在导出里（zip 为存储方式，可直接检索）
  expect((await h.app.request("/v1/export")).status).toBe(401);
});

test("导出 confirmed 和 candidate 及修订、提醒及触发记录，并按当前 owner 计数", async () => {
  const clock = new FakeClock(Date.UTC(2026, 10, 6, 7));
  const memory = new MemoryService(db, clock);
  const reminders = new ReminderService(db, clock);
  const remember = (id: string, key: string, value: string, status?: "candidate") => memory.remember(id, {
    kind: "preference", key, value, status, source: { kind: "manual" }, changedBy: "user",
  });
  const confirmed = await remember(ownerId, "export.confirmed", "旧值");
  await memory.update(ownerId, confirmed.memoryId, { value: "新值", expected_revision: confirmed.revision });
  const candidate = await remember(ownerId, "export.candidate", "候选值", "candidate");
  const revoked = await remember(ownerId, "export.revoked", "隐藏值");
  await memory.revoke(ownerId, revoked.memoryId);
  await db.run("INSERT INTO app_owners (id, display_name, created_at) VALUES ('other-owner', '其他 owner', ?)", clock.now());
  await remember("other-owner", "export.other", "其他 owner 的记忆");
  const create = (id: string, text: string) => reminders.create(id, { text, timezone: "UTC", local_datetime: "2026-11-06T07:01" });
  const schedule = await create(ownerId, "纳入导出的提醒");
  await create("other-owner", "其他 owner 的提醒");
  clock.advance(60_000);
  expect(await new Scheduler(db, clock).tick()).toBe(2);

  const response = await call("GET", "/v1/export");
  expect(response.status).toBe(200);
  const files = zipFiles(Buffer.from(await response.arrayBuffer()));
  const read = (name: string): unknown => JSON.parse(files.get(name)!.toString("utf8"));
  expect(read("manifest.json")).toMatchObject({
    counts: { documents: 0, versions: 0, memories: 2, memory_revisions: 3, schedules: 1, occurrences: 1 },
  });
  const memories = read("memories.json") as { status: string }[];
  expect(memories).toHaveLength(2);
  expect(memories.toSorted((a, b) => b.status.localeCompare(a.status))).toMatchObject([
    { id: confirmed.memoryId, status: "confirmed", revisions: [{ revision: 1, value: "旧值" }, { revision: 2, value: "新值" }] },
    { id: candidate.memoryId, status: "candidate", revisions: [{ revision: 1, value: "候选值" }] },
  ]);
  expect(read("reminders.json")).toMatchObject({
    schedules: [{ id: schedule.id, text: "纳入导出的提醒", status: "fired" }],
    occurrences: [{ schedule_id: schedule.id, revision: 1, fire_at: schedule.nextFireAt }],
  });
});

test("S11：日志和导出包里检索不到消息正文、口令、口令哈希和 API key", async () => {
  const conv = (await (await call("POST", "/v1/conversations", {})).json()) as { id: string };
  const sent = await call("POST", `/v1/conversations/${conv.id}/messages`, { client_request_id: crypto.randomUUID(), text: MESSAGE });
  expect(sent.status).toBe(202);
  await runtime.waitSubmission(((await sent.json()) as { submission_id: string }).submission_id);
  await call("POST", "/v1/auth/login", { password: "wrong password" }); // 失败登录也不应进日志
  await call("POST", "/v1/documents", { client_request_id: crypto.randomUUID(), type: "text", text: "一篇资料" });
  await worker.idle();
  const hash = (await db.get<{ password_hash: string }>("SELECT password_hash FROM app_auth WHERE owner_id = ?", ownerId))!.password_hash;
  expect(hash.length).toBeGreaterThan(20);
  const zip = Buffer.from(await (await call("GET", "/v1/export")).arrayBuffer());
  const logText = JSON.stringify(logs);
  expect(logs.length).toBeGreaterThan(0);
  for (const secret of [MESSAGE, PASSWORD, "wrong password", hash, API_KEY, "sid="]) {
    expect(logText.includes(secret), `日志含 ${secret.slice(0, 8)}…`).toBe(false);
    expect(zip.includes(Buffer.from(secret)), `导出包含 ${secret.slice(0, 8)}…`).toBe(false);
  }
});
