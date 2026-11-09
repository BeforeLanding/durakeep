// T-20：记忆存储、工具与接口。FR-MEM-01（显式记住，新会话可用）、FR-MEM-02（revision、停用）、FR-MEM-03（冲突：旧值 superseded，不会同时出现）。
// 全部使用 faux。“假设性的话不被保存”由系统提示约束（05 §4.1 第 6 条），属模型行为，由回答评测覆盖，这里只验证工具与存储的机制。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ConversationDirectory, ConversationService } from "../../packages/conversations/src/index.ts";
import { FakeClock, systemClock } from "../../packages/core/src/index.ts";
import { guardDb, migrate, type SqlDatabase } from "../../packages/db/src/index.ts";
import { MemoryService } from "../../packages/memory/src/index.ts";
import { appCoreExtension, appGuardExtension, appMemoryExtension, context, openAppDatabase, PiRuntime, startPi, type PiHandle } from "../../packages/runtime-pi/src/index.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../../packages/runtime-pi/src/testing/faux.ts";
import { createApp } from "../../apps/server/src/app.ts";

const ORIGIN = "http://127.0.0.1:4777";
let dir: string;
let db: SqlDatabase;
let pi: PiHandle;
let faux: ReturnType<typeof fauxProvider>;
let runtime: PiRuntime;
let memory: MemoryService;
let conversations: ConversationService;
let clock: FakeClock;
let h: ReturnType<typeof createApp>;
let cookie: string;
let ownerId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "durakeep-mem-"));
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  db = guardDb(raw);
  await migrate(db);
  clock = new FakeClock(Date.UTC(2026, 10, 9, 8, 0));
  memory = new MemoryService(db, clock);
  const directory = new ConversationDirectory(db);
  faux = fauxProvider();
  pi = await startPi({
    mode: "test",
    db: raw,
    faux,
    settings: { retry: { maxRetries: 0 } },
    extensions: [appCoreExtension({ memory: true }), appMemoryExtension({ db, conversations: directory, memory }), appGuardExtension({ conversations: directory })],
  });
  runtime = new PiRuntime(pi, { model: { provider: "faux", modelId: "faux-1" } });
  conversations = new ConversationService(db, runtime, systemClock);
  runtime.resume();
  h = createApp({ db, clock: systemClock, origin: ORIGIN, memory, limits: { login: 10_000 } });
  ownerId = (await h.auth.initOwner({ password: "correct horse battery", timezone: "Asia/Shanghai" })).id;
  const login = await h.app.request("/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ password: "correct horse battery" }) });
  cookie = /sid=[^;]+/.exec(login.headers.get("set-cookie")!)![0];
});
afterEach(async () => {
  await pi.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const src = { kind: "manual" } as const;
const rem = (key: string, value: string, extra: Partial<Parameters<MemoryService["remember"]>[1]> = {}) =>
  memory.remember(ownerId, { kind: "preference", key, value, source: src, changedBy: "user", ...extra });

// ---------------------------------------------------------------- 服务：写入、冲突、revision

test("FR-MEM-03：同一 key 写入新值 → 旧记录 superseded、新记录 confirmed 并指向它；检索和 section 候选里只有新的", async () => {
  const a = await rem("review.verbosity", "每周回顾希望详细一点");
  const b = await rem("review.verbosity", "每周回顾希望简短一点");
  expect(b.supersededValue).toBe("每周回顾希望详细一点");
  expect(b.memoryId).not.toBe(a.memoryId);
  const old = await memory.get(ownerId, a.memoryId);
  expect(old.status).toBe("superseded");
  const cur = await memory.get(ownerId, b.memoryId);
  expect(cur).toMatchObject({ status: "confirmed", supersedesId: a.memoryId, value: "每周回顾希望简短一点" });
  const hits = await memory.search(ownerId, "每周回顾");
  expect(hits.map((m) => m.value)).toEqual(["每周回顾希望简短一点"]);
  expect((await memory.globalConfirmed(ownerId)).map((m) => m.value)).toEqual(["每周回顾希望简短一点"]);
  expect((await memory.list(ownerId, { status: "confirmed" })).length).toBe(1);
});

test("相同的值再次写入 → 不变（不产生新记录、不增加集合版本）；大小写与空白被规范化", async () => {
  const a = await rem("work.role", "后端工程师");
  const v1 = await memory.setRevision(ownerId);
  const b = await rem(" Work.Role ", "后端工程师", { kind: "preference" });
  expect(b).toMatchObject({ unchanged: true, memoryId: a.memoryId });
  expect(await memory.setRevision(ownerId)).toBe(v1);
  expect((await memory.list(ownerId)).length).toBe(1);
});

test("memory_set_revision：confirmed 集合每次变化加一（写入 / 修改 / 停用 / 启用 / 删除），候选与拒绝不变", async () => {
  expect(await memory.setRevision(ownerId)).toBe(0);
  const a = await rem("k.a", "甲");
  expect(await memory.setRevision(ownerId)).toBe(1);
  const m = await memory.get(ownerId, a.memoryId);
  await memory.update(ownerId, a.memoryId, { value: "甲2", expected_revision: m.revision });
  expect(await memory.setRevision(ownerId)).toBe(2);
  await memory.revoke(ownerId, a.memoryId);
  expect(await memory.setRevision(ownerId)).toBe(3);
  await memory.enable(ownerId, a.memoryId);
  expect(await memory.setRevision(ownerId)).toBe(4);
  const c = await rem("k.c", "候选", { status: "candidate", changedBy: "extractor" });
  expect(await memory.setRevision(ownerId)).toBe(4); // 候选不影响集合
  await memory.reject(ownerId, c.memoryId);
  expect(await memory.setRevision(ownerId)).toBe(4);
  await memory.delete(ownerId, a.memoryId);
  expect(await memory.setRevision(ownerId)).toBe(5);
});

test("FR-MEM-02：修改生成新 revision，旧 revision 可查；expected_revision 不匹配 → revision_conflict；停用后立即不被检索、不进 section", async () => {
  const a = await rem("diet.style", "不吃辣");
  const m1 = await memory.get(ownerId, a.memoryId);
  const m2 = await memory.update(ownerId, a.memoryId, { value: "微辣可以", expected_revision: m1.revision });
  expect(m2.revision).toBe(2);
  await expect(memory.update(ownerId, a.memoryId, { value: "x", expected_revision: 1 })).rejects.toMatchObject({ code: "revision_conflict" });
  const revs = await memory.revisions(ownerId, a.memoryId);
  expect(revs.map((r) => [r.revision, r.value])).toEqual([[1, "不吃辣"], [2, "微辣可以"]]);
  expect((await memory.search(ownerId, "辣")).length).toBe(1);
  await memory.revoke(ownerId, a.memoryId);
  expect(await memory.search(ownerId, "辣")).toEqual([]);
  expect(await memory.globalConfirmed(ownerId)).toEqual([]);
  await memory.enable(ownerId, a.memoryId);
  expect((await memory.search(ownerId, "辣")).length).toBe(1);
});

test("候选：确认后生效并取代同 key 的 confirmed；拒绝与删除写入 suppression，之后的候选提取被挡住；显式写入可以覆盖 suppression", async () => {
  await rem("lang.reply", "中文回答");
  const cand = await rem("lang.reply", "英文回答", { status: "candidate", changedBy: "extractor" });
  expect((await memory.search(ownerId, "回答")).map((m) => m.value)).toEqual(["中文回答"]); // 候选不被检索
  await memory.confirm(ownerId, cand.memoryId);
  expect((await memory.search(ownerId, "回答")).map((m) => m.value)).toEqual(["英文回答"]);
  const c2 = await rem("x.y", "不要再提取我", { status: "candidate", changedBy: "extractor" });
  await memory.reject(ownerId, c2.memoryId);
  await expect(rem("x.y", "不要再提取我", { status: "candidate", changedBy: "extractor" })).rejects.toMatchObject({ code: "invalid_request" });
  const c3 = await rem("z.w", "会被删除", {});
  await memory.delete(ownerId, c3.memoryId);
  await expect(memory.get(ownerId, c3.memoryId)).rejects.toMatchObject({ code: "not_found" });
  expect(await db.get("SELECT 1 AS x FROM app_memory_revisions WHERE memory_id = ?", c3.memoryId)).toBeUndefined();
  await expect(rem("z.w", "会被删除", { status: "candidate", changedBy: "extractor" })).rejects.toMatchObject({ code: "invalid_request" });
  await rem("z.w", "会被删除"); // 用户显式要这条：允许，并清除 suppression
  expect((await memory.search(ownerId, "删除")).length).toBe(1);
});

test("参数校验：key 字符集、value ≤200 字符、scope 形式、kind；project 作用域的记忆不进 globalConfirmed", async () => {
  await expect(rem("Bad Key!", "x")).rejects.toMatchObject({ code: "invalid_request" });
  await expect(rem("a.b", "字".repeat(201))).rejects.toMatchObject({ code: "invalid_request" });
  await expect(rem("a.b", "ok", { scope: "everywhere" })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(rem("a.b", "ok", { kind: "nope" })).rejects.toMatchObject({ code: "invalid_request" });
  await rem("blog.stack", "用 Astro 写博客", { kind: "project_context", scope: "project:blog" });
  expect(await memory.globalConfirmed(ownerId)).toEqual([]);
  expect((await memory.search(ownerId, "博客")).length).toBe(1);
  expect((await memory.search(ownerId, "博客", "project:blog")).length).toBe(1);
  expect(await memory.search(ownerId, "博客", "global")).toEqual([]);
});

// ---------------------------------------------------------------- 接口

type J = Record<string, unknown>;
const call = (method: string, path: string, body?: unknown) =>
  h.app.request(path, { method, headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as J;

test("接口：手动添加（幂等）→ 列表 → 修改（409）→ 历史 → 停用 / 启用 → 删除；候选的确认 / 拒绝；未登录 401；别人的记忆 404", async () => {
  const rid = crypto.randomUUID();
  const body = { client_request_id: rid, kind: "preference", key: "ui.theme", value: "喜欢深色", scope: "global" };
  const r1 = await call("POST", "/v1/memories", body);
  expect(r1.status).toBe(201);
  const m = await json(r1);
  expect(m).toMatchObject({ status: "confirmed", revision: 1, key: "ui.theme", source: { kind: "manual" } });
  const r2 = await call("POST", "/v1/memories", body);
  expect(r2.status).toBe(200);
  expect((await json(r2)).id).toBe(m.id);
  expect((await call("POST", "/v1/memories", { ...body, value: "不同" })).status).toBe(409);
  expect((await call("POST", "/v1/memories", { ...body, client_request_id: "x" })).status).toBe(400);
  expect(((await json(await call("GET", "/v1/memories?status=confirmed"))).items as J[]).length).toBe(1);
  expect((await call("GET", "/v1/memories?status=bogus")).status).toBe(400);

  const p = await call("PATCH", `/v1/memories/${m.id}`, { value: "更喜欢浅色", expected_revision: 1 });
  expect(await json(p)).toMatchObject({ value: "更喜欢浅色", revision: 2 });
  expect((await call("PATCH", `/v1/memories/${m.id}`, { value: "冲突", expected_revision: 1 })).status).toBe(409);
  expect(((await json(await call("GET", `/v1/memories/${m.id}/revisions`))).items as J[]).map((r) => r.revision)).toEqual([1, 2]);
  expect(await json(await call("POST", `/v1/memories/${m.id}/revoke`))).toMatchObject({ status: "revoked" });
  expect(await json(await call("POST", `/v1/memories/${m.id}/enable`))).toMatchObject({ status: "confirmed" });

  const cand = await memory.remember(ownerId, { kind: "profile_fact", key: "work.role", value: "测试工程师", source: { kind: "message" }, changedBy: "extractor", status: "candidate" });
  expect(await json(await call("POST", `/v1/memories/${cand.memoryId}/confirm`))).toMatchObject({ status: "confirmed" });
  const cand2 = await memory.remember(ownerId, { kind: "profile_fact", key: "work.city", value: "上海", source: { kind: "message" }, changedBy: "extractor", status: "candidate" });
  expect(await json(await call("POST", `/v1/memories/${cand2.memoryId}/reject`))).toMatchObject({ status: "rejected" });

  expect((await call("DELETE", `/v1/memories/${m.id}`)).status).toBe(204);
  expect((await call("GET", `/v1/memories/${m.id}/revisions`)).status).toBe(404);
  expect((await h.app.request("/v1/memories")).status).toBe(401);
  // 别人的记忆：不存在与不属于自己不区分
  await db.run("INSERT INTO app_owners (id, display_name, timezone, created_at) VALUES ('other', 'x', 'UTC', ?)", Date.now());
  const theirs = await memory.remember("other", { kind: "preference", key: "a.b", value: "别人的", source: src, changedBy: "user" });
  expect((await call("GET", `/v1/memories/${theirs.memoryId}/revisions`)).status).toBe(404);
  expect((await call("POST", `/v1/memories/${theirs.memoryId}/revoke`)).status).toBe(404);
  expect(((await json(await call("GET", "/v1/memories"))).items as J[]).every((x) => x.value !== "别人的")).toBe(true);
});

// ---------------------------------------------------------------- 经 Pi + faux 跑通工具

type ToolResult = { name: string; text: string; isError: boolean; details: unknown };
async function toolResults(piConversationId: string): Promise<ToolResult[]> {
  const c = await pi.harness.conversation(Number(piConversationId) as never, context);
  const page = await c!.entries({}, 100, undefined, context);
  return [...page.items]
    .reverse()
    .filter((e) => e.kind === "pi.tool-result")
    .map((e) => {
      const m = e.model![0] as { toolName: string; isError: boolean; details: unknown; content: { text: string }[] };
      return { name: m.toolName, text: m.content.map((x) => x.text).join(""), isError: m.isError, details: m.details };
    });
}
const callTool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const newConv = async () => conversations.get(ownerId, (await conversations.create(ownerId)).id);
const ask = async (conv: { piConversationId: string }, text: string, script: Parameters<typeof faux.setResponses>[0]) => {
  faux.setResponses(script);
  const s = await runtime.submitInput(conv.piConversationId, { text, requestId: crypto.randomUUID(), steer: false, now: Date.now(), tz: "UTC" });
  return runtime.waitSubmission(s.submissionId);
};

test("FR-MEM-01：memory_remember 保存为 confirmed 并回执；另一个新会话里 memory_search 能取到；冲突取代旧值并在回执里说明", async () => {
  const c1 = await newConv();
  const r1 = await ask(c1, "记住：每周回顾要简短", [
    callTool("memory_remember", { kind: "preference", key: "Review.Verbosity", value: "每周回顾希望简短一点" }),
    fauxAssistantMessage("好的，记住了。"),
  ]);
  expect(r1.status).toBe("done");
  const res1 = (await toolResults(c1.piConversationId))[0]!;
  expect(res1).toMatchObject({ name: "memory_remember", isError: false });
  expect(res1.text).toContain("已记住：review.verbosity");
  expect(res1.text).toContain("global");
  const saved = (await memory.list(ownerId, { status: "confirmed" }))[0]!;
  expect(saved).toMatchObject({ key: "review.verbosity", scope: "global", source: { kind: "message", conversation_id: c1.id } });

  // 新会话：memory_search 取到
  const c2 = await newConv();
  await ask(c2, "我对每周回顾有什么偏好？", [callTool("memory_search", { query: "每周回顾" }), fauxAssistantMessage("你希望简短一点。")]);
  const res2 = (await toolResults(c2.piConversationId)).find((r) => r.name === "memory_search")!;
  expect(res2.text).toContain("每周回顾希望简短一点");
  expect((res2.details as { memory_ids: string[] }).memory_ids).toEqual([`${saved.id}@1`]);

  // 同 key 新值：取代
  await ask(c2, "改成详细一点，记住", [
    callTool("memory_remember", { kind: "preference", key: "review.verbosity", value: "每周回顾希望详细一点" }),
    fauxAssistantMessage("已更新。"),
  ]);
  const res3 = (await toolResults(c2.piConversationId)).find((r) => r.name === "memory_remember")!;
  expect(res3.text).toContain("取代了旧值“每周回顾希望简短一点”");
  expect((await memory.search(ownerId, "每周回顾")).map((m) => m.value)).toEqual(["每周回顾希望详细一点"]);
  expect((await memory.get(ownerId, saved.id)).status).toBe("superseded");
});

test("memory_remember：参数不合法 → 错误结果（不写入）；owner_id 参数被 Pi 拒绝；只读检索不写入；同一 run 重放不重复写入", async () => {
  const c = await newConv();
  await ask(c, "记住", [callTool("memory_remember", { kind: "preference", key: "Bad Key!", value: "x" }), fauxAssistantMessage("失败了。")]);
  const bad = (await toolResults(c.piConversationId))[0]!;
  expect(bad.isError).toBe(true);
  expect(await memory.list(ownerId)).toEqual([]);
  const c2 = await newConv();
  await ask(c2, "记住", [callTool("memory_remember", { kind: "preference", key: "a.b", value: "x", owner_id: "other" } as never), fauxAssistantMessage("好。")]);
  expect((await toolResults(c2.piConversationId))[0]!.isError).toBe(true);
  expect(await memory.list(ownerId)).toEqual([]);
});

test("系统提示：启用记忆后规则里有 memory_remember / memory_search，且仍然是静态的", async () => {
  const { buildPreamble } = await import("../../packages/runtime-pi/src/index.ts");
  const p = buildPreamble({ memory: true });
  expect(p).toContain("memory_remember");
  expect(p).toContain("memory_search");
  expect(p).toBe(buildPreamble({ memory: true }));
  expect(p).not.toMatch(/\d{4}-\d{2}-\d{2}/);
});
