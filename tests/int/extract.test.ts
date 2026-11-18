// T-24：候选记忆提取（FR-MEM-04、R5）。进程内，faux，零费用。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { isSensitive, parseCandidates } from "../../packages/memory/src/index.ts";
import { fauxAssistantMessage, fauxProvider } from "../../packages/runtime-pi/src/testing/faux.ts";
import { openBg } from "../support/bg.ts";

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const NOW = Date.UTC(2026, 10, 18, 3, 0);
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "durakeep-ext-"));
  dirs.push(dir);
  const faux = fauxProvider();
  const s = await openBg(dir, faux);
  s.pi.harness.resume();
  s.worker.start();
  closers.push(async () => {
    await s.worker.stop();
    await s.rt.close();
  });
  const conv = await s.conversations.create(s.owner);
  const piId = (await s.db.get<{ pi_conversation_id: string }>("SELECT pi_conversation_id FROM app_conversations WHERE id = ?", conv.id))!.pi_conversation_id;
  /** 发 n 轮对话（每轮一条用户消息 + 一条助手回复）。 */
  let seq = 0;
  const talk = async (n: number, text: (i: number) => string = (i) => `第${i}句用户的话`) => {
    for (let i = 0; i < n; i++) {
      faux.setResponses([fauxAssistantMessage("好的")]);
      const { submissionId } = await s.rt.submitInput(piId, { text: text(++seq), requestId: `t:${seq}`, steer: false, now: NOW, tz: "Asia/Shanghai" });
      await s.rt.waitSubmission(submissionId);
    }
  };
  /** 让会话“空闲 11 分钟”，扫描、等作业完成。返回扫描入队数。 */
  let bump = 0;
  const idleScan = async () => {
    await s.db.run("UPDATE app_conversations SET last_active_at = ? WHERE id = ?", Date.now() - 11 * 60_000 - ++bump, conv.id); // 每次不同：dedupe 键含它
    const n = await s.extraction.scan();
    await s.worker.idle();
    return n;
  };
  const cands = () => s.memory.list(s.owner, { status: "candidate" });
  const cursor = async () => (await s.db.get<{ value_json: string }>("SELECT value_json FROM app_settings WHERE key = ?", `extract_cursor:${conv.id}`))?.value_json;
  return { ...s, faux, conv, talk, idleScan, cands, cursor };
}

const item = (o: Record<string, unknown>) => ({ kind: "preference", scope: "global", ...o });

test("parseCandidates / isSensitive", () => {
  expect(parseCandidates('好的：\n```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
  expect(parseCandidates("没有")).toBeUndefined();
  expect(parseCandidates("[坏的")).toBeUndefined();
  for (const [k, v] of [["health.condition", "我患有糖尿病"], ["work.pay", "月薪两万"], ["x.y", "我的银行卡号是"], ["x.y", "他信仰佛教"], ["account.password", "abc"], ["x", "my salary is high"]] as const) expect(isSensitive(k, v)).toBe(true);
  expect(isSensitive("review.verbosity", "回答要简洁")).toBe(false);
});

test("空闲 + ≥4 条新用户消息 → 候选；敏感 / 非法的被过滤；游标推进；不影响集合版本；提示里没有工具结果", async () => {
  const t = await setup();
  await t.talk(4);
  let seen = "";
  const before = await t.memory.setRevision(t.owner);
  t.faux.setResponses([
    (c) => {
      seen = JSON.stringify(c);
      return fauxAssistantMessage(
        JSON.stringify([
          item({ key: "review.verbosity", value: "回答要简洁", evidence_entry_id: "1" }),
          item({ kind: "profile_fact", key: "work.role", value: "后端工程师" }),
          item({ key: "pay.salary", value: "月薪三万" }), // 敏感
          item({ kind: "mood", key: "x.y", value: "非法 kind" }),
          item({ key: "Bad Key", value: "非法 key" }),
        ]),
      );
    },
  ]);
  expect(await t.idleScan()).toBe(1);
  const list = await t.cands();
  expect(list.map((m) => m.key).sort()).toEqual(["review.verbosity", "work.role"]);
  expect(list.every((m) => m.status === "candidate" && m.source.kind === "message" && m.source.conversation_id === t.conv.id)).toBe(true);
  expect(await t.memory.setRevision(t.owner)).toBe(before); // 候选不影响集合版本（ADR-05）
  expect(seen).toContain("<conversation>");
  expect(seen).toContain("第1句用户的话");
  expect(seen).not.toContain("kb_search");
  expect(await t.cursor()).toBeDefined();
  expect(await t.extraction.scan()).toBe(0); // 没有新活动：不会再入队
});

test("新增不足 4 条：不调用模型、游标不推进；攒够后只处理游标之后的内容", async () => {
  const t = await setup();
  await t.talk(3);
  await t.idleScan();
  expect(t.faux.state.callCount).toBe(3); // 只有 3 次对话回复，没有提取调用
  expect(await t.cursor()).toBeUndefined();
  await t.talk(1, () => "第四句");
  let seen = "";
  t.faux.setResponses([(c) => ((seen = JSON.stringify(c)), fauxAssistantMessage("[]"))]);
  await t.idleScan();
  expect(seen).toContain("第1句用户的话"); // 游标没动，前 3 条一并处理
  const c1 = await t.cursor();
  expect(c1).toBeDefined();
  await t.talk(4, (i) => `后来第${i}句`);
  seen = "";
  t.faux.setResponses([(c) => ((seen = JSON.stringify(c)), fauxAssistantMessage("[]"))]);
  await t.idleScan();
  expect(seen).toContain("后来第");
  expect(seen).not.toContain("第1句用户的话"); // 已处理过的不再送去
  expect(Number(await t.cursor())).toBeGreaterThan(Number(c1));
});

test("R5：提取期间原记忆被删除 → 提交前查 suppression，不会写回；已被拒绝的候选同理", async () => {
  const t = await setup();
  const kept = await t.memory.remember(t.owner, { kind: "preference", key: "editor.theme", value: "深色主题", source: { kind: "manual" }, changedBy: "user" });
  await t.talk(4);
  t.faux.setResponses([
    async () => {
      await t.memory.delete(t.owner, kept.memoryId); // 模型“思考”期间，用户删除了这条记忆
      return fauxAssistantMessage(JSON.stringify([item({ key: "editor.theme", value: "深色主题" }), item({ key: "editor.font", value: "等宽字体" })]));
    },
  ]);
  await t.idleScan();
  expect((await t.cands()).map((m) => m.key)).toEqual(["editor.font"]); // 被删的没有回来
  const [cand] = await t.cands();
  await t.memory.reject(t.owner, cand!.id); // 拒绝候选后，再次提取同值不再出现
  await t.talk(4, (i) => `再来第${i}句`);
  t.faux.setResponses([fauxAssistantMessage(JSON.stringify([item({ key: "editor.font", value: "等宽字体" })]))]);
  await t.idleScan();
  expect(await t.cands()).toEqual([]);
});

test("与现有 confirmed 值相同的丢弃；值不同的作为候选保留", async () => {
  const t = await setup();
  await t.memory.remember(t.owner, { kind: "preference", key: "review.verbosity", value: "回答要简洁", source: { kind: "manual" }, changedBy: "user" });
  await t.talk(4);
  t.faux.setResponses([fauxAssistantMessage(JSON.stringify([item({ key: "review.verbosity", value: "回答要简洁" }), item({ key: "review.language", value: "用中文" })]))]);
  await t.idleScan();
  expect((await t.cands()).map((m) => m.key)).toEqual(["review.language"]);
});

test("输出不是 JSON：作业重试并换新的 requestId 重新询问；未空闲 / 已归档的会话不会被扫描", async () => {
  const t = await setup();
  await t.talk(4);
  t.faux.setResponses([fauxAssistantMessage("抱歉，没有"), fauxAssistantMessage(JSON.stringify([item({ key: "a.b", value: "值" })]))]);
  await t.db.run("UPDATE app_conversations SET last_active_at = ? WHERE id = ?", Date.now() - 11 * 60_000, t.conv.id);
  await t.extraction.scan();
  for (let i = 0; i < 200 && (await t.cands()).length === 0; i++) await new Promise((x) => setTimeout(x, 25)); // 退避只有 10 ms，idle() 不等未到期的作业
  expect((await t.cands()).map((m) => m.key)).toEqual(["a.b"]);

  const t2 = await setup();
  await t2.talk(4);
  expect(await t2.extraction.scan()).toBe(0); // 刚活动过：未空闲
  await t2.db.run("UPDATE app_conversations SET last_active_at = ?, archived_at = ? WHERE id = ?", Date.now() - 11 * 60_000, 1, t2.conv.id);
  await t2.extraction.scan();
  await t2.worker.idle();
  expect(t2.faux.state.callCount).toBe(4); // 没有提取调用
});
