// T-21：profile section（ADR-05）。K5 在真实的记忆数据上复测：偏好不变 → 连续 10 次请求 pi.system 不追加；变化 → 追加 1 次。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ConversationDirectory, ConversationService } from "../../packages/conversations/src/index.ts";
import { FakeClock, systemClock } from "../../packages/core/src/index.ts";
import { guardDb, migrate, type SqlDatabase } from "../../packages/db/src/index.ts";
import { MemoryService } from "../../packages/memory/src/index.ts";
import { appCoreExtension, appGuardExtension, appProfileExtension, context, openAppDatabase, PiRuntime, startPi, type PiHandle } from "../../packages/runtime-pi/src/index.ts";
import { fauxAssistantMessage, fauxProvider } from "../../packages/runtime-pi/src/testing/faux.ts";

let dir: string;
let db: SqlDatabase;
let pi: PiHandle;
let faux: ReturnType<typeof fauxProvider>;
let runtime: PiRuntime;
let memory: MemoryService;
let conversations: ConversationService;
let renders: number;
let seen: string[];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "durakeep-prof-"));
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  db = guardDb(raw);
  await migrate(db);
  for (const id of ["o1", "o2"]) await db.run("INSERT INTO app_owners (id, display_name, timezone, created_at) VALUES (?, 'x', 'UTC', ?)", id, Date.now());
  memory = new MemoryService(db, new FakeClock(Date.UTC(2026, 10, 9)));
  const directory = new ConversationDirectory(db);
  // 统计 section 渲染次数：包一层 setRevision
  renders = 0;
  const counted = new Proxy(memory, {
    get(t, p) {
      if (p === "setRevision") return (...a: Parameters<MemoryService["setRevision"]>) => (renders++, t.setRevision(...a));
      const v = Reflect.get(t, p, t) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  faux = fauxProvider();
  seen = [];
  faux.setResponses(Array.from({ length: 40 }, () => (ctx: unknown) => (seen.push(JSON.stringify(ctx)), fauxAssistantMessage("好"))));
  pi = await startPi({
    mode: "test",
    db: raw,
    faux,
    settings: { retry: { maxRetries: 0 } },
    extensions: [appCoreExtension({ memory: true }), appProfileExtension({ conversations: directory, memory: counted }), appGuardExtension({ conversations: directory })],
  });
  runtime = new PiRuntime(pi, { model: { provider: "faux", modelId: "faux-1" } });
  conversations = new ConversationService(db, runtime, systemClock);
  runtime.resume();
});
afterEach(async () => {
  await pi.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const newConv = async (owner: string) => conversations.get(owner, (await conversations.create(owner)).id);
const say = async (conv: { piConversationId: string }, text: string) => {
  const s = await runtime.submitInput(conv.piConversationId, { text, requestId: crypto.randomUUID(), steer: false, now: Date.now(), tz: "UTC" });
  expect((await runtime.waitSubmission(s.submissionId)).status).toBe("done");
};
const systemCount = async (conv: { piConversationId: string }) => {
  const c = await pi.harness.conversation(Number(conv.piConversationId) as never, context);
  return (await c!.entries({}, 200, undefined, context)).items.filter((e) => e.kind === "pi.system").length;
};
const rem = (owner: string, key: string, value: string, scope = "global") => memory.remember(owner, { kind: "preference", key, value, scope, source: { kind: "manual" }, changedBy: "user" });

test("K5（真实记忆）：偏好不变时连续 10 次请求不追加 pi.system，每次请求都渲染（读版本号）；偏好变化后追加 1 次", async () => {
  await rem("o1", "review.verbosity", "每周回顾希望简短一点");
  const c = await newConv("o1");
  for (let i = 0; i < 10; i++) await say(c, `问${i}`);
  expect(await systemCount(c)).toBe(1);
  expect(renders).toBeGreaterThanOrEqual(10);
  expect(seen.at(-1)).toContain("<profile>");
  expect(seen.at(-1)).toContain("[review.verbosity] 每周回顾希望简短一点");
  await rem("o1", "answer.lang", "用中文回答");
  await say(c, "问10");
  expect(await systemCount(c)).toBe(2);
  await say(c, "问11");
  expect(await systemCount(c)).toBe(2);
  expect(seen.at(-1)).toContain("[answer.lang] 用中文回答");
});

test("只含 global + confirmed：project 作用域、候选、停用、被取代的都不出现；按 key 排序；owner 隔离", async () => {
  await rem("o1", "b.second", "乙");
  await rem("o1", "a.first", "甲");
  await rem("o1", "blog.stack", "项目记忆", "project:blog");
  const stale = await rem("o1", "old.key", "停用的");
  await memory.revoke("o1", stale.memoryId);
  await rem("o1", "swap.key", "旧值");
  await rem("o1", "swap.key", "新值");
  await memory.remember("o1", { kind: "preference", key: "cand.key", value: "候选", source: { kind: "message" }, changedBy: "extractor", status: "candidate" });
  await rem("o2", "other.owner", "别人的偏好");
  const c = await newConv("o1");
  await say(c, "你好");
  const ctx = seen.at(-1)!;
  const profile = ctx.slice(ctx.indexOf("<profile>"), ctx.indexOf("</profile>"));
  expect(profile).toContain("[a.first] 甲");
  expect(profile.indexOf("a.first")).toBeLessThan(profile.indexOf("b.second"));
  expect(profile).toContain("[swap.key] 新值");
  for (const bad of ["项目记忆", "停用的", "旧值", "候选", "别人的偏好"]) expect(profile).not.toContain(bad);
});

test("没有记忆时省略 section；最多 20 条", async () => {
  const c = await newConv("o1");
  await say(c, "你好");
  expect(seen.at(-1)).not.toContain("<profile>");
  for (let i = 0; i < 25; i++) await rem("o1", `k.${String(i).padStart(2, "0")}`, `值${i}`);
  const c2 = await newConv("o1");
  await say(c2, "你好");
  const ctx = seen.at(-1)!;
  expect((ctx.match(/\[k\.\d\d\]/g) ?? []).length).toBe(20);
});
