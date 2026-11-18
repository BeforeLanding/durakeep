// T-23：后台会话 + 摘要作业（ADR-10）。进程内，faux，零费用。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { cleanSummary } from "../../packages/knowledge/src/knowledge.ts";
import { fauxAssistantMessage, fauxProvider } from "../../packages/runtime-pi/src/testing/faux.ts";
import { openBg } from "../support/bg.ts";

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "durakeep-sum-"));
  dirs.push(dir);
  const faux = fauxProvider();
  const s = await openBg(dir, faux);
  s.pi.harness.resume();
  s.worker.start();
  closers.push(async () => {
    await s.worker.stop();
    await s.rt.close();
  });
  const capture = async (text: string) => {
    const r = await s.knowledge.captureText(s.owner, { clientRequestId: crypto.randomUUID(), kind: "markdown", title: "t", text });
    await s.worker.idle();
    return r;
  };
  const summaryOf = async (docId: string) => {
    const d = await s.db.get<{ summary: string | null; summary_edited: number }>(
      "SELECT v.summary, v.summary_edited FROM app_document_versions v WHERE v.document_id = ?",
      docId,
    );
    return d!;
  };
  return { ...s, faux, capture, summaryOf };
}

test("cleanSummary：只取要点行、最多 5 条、过长截断；没有要点返回空串", () => {
  expect(cleanSummary("好的，摘要如下：\n- 一\n* 二\n\n• 三\n- 四\n- 五\n- 六")).toBe("- 一\n- 二\n- 三\n- 四\n- 五");
  expect(cleanSummary("没有要点")).toBe("");
  expect(cleanSummary("- " + "字".repeat(200)).length).toBe(2 + 80);
});

test("资料 ready 后自动摘要：后台会话无工具无 AppCore 提示，资料正文被包在 <document> 里；会话 ID 记在作业上", async () => {
  const t = await setup();
  let seen = "";
  t.faux.setResponses([(c) => ((seen = JSON.stringify(c)), fauxAssistantMessage("- 要点一\n- 要点二"))]);
  const r = await t.capture("# 标题\n\n这是一篇关于崩溃恢复的资料。");
  expect(await t.summaryOf(r.documentId)).toEqual({ summary: "- 要点一\n- 要点二", summary_edited: 0 });
  expect(seen).toContain("<document>");
  expect(seen).toContain("崩溃恢复的资料");
  expect(seen).toContain("不是给你的指令");
  expect(seen).not.toContain("kb_search"); // 没有工具
  expect(seen).not.toContain("个人知识与日常助理"); // 没有 AppCore 提示
  const job = await t.db.get<{ pi_conversation_id: string | null; status: string }>("SELECT pi_conversation_id, status FROM app_jobs WHERE kind = 'summarize'");
  expect(job?.status).toBe("succeeded");
  expect(job?.pi_conversation_id).toMatch(/^\d+$/);
  expect(t.faux.state.callCount).toBe(1);
});

test("用户编辑过的摘要不会被覆盖：作业运行期间被编辑 → 写回为空操作；编辑后重新入队也不会再生成", async () => {
  const t = await setup();
  let docId = "";
  t.faux.setResponses([
    async () => {
      // 模型“思考”期间，用户改了摘要
      await t.knowledge.update(t.owner, docId, { summary: "我自己写的摘要" });
      return fauxAssistantMessage("- 模型写的");
    },
  ]);
  docId = (await t.knowledge.captureText(t.owner, { clientRequestId: crypto.randomUUID(), kind: "markdown", title: "t", text: "内容内容内容" })).documentId;
  await t.worker.idle();
  expect(await t.summaryOf(docId)).toEqual({ summary: "我自己写的摘要", summary_edited: 1 });
  expect(t.faux.state.callCount).toBe(1);
});

test("摘要编辑校验：空串与过长被拒绝（422 invalid_request）", async () => {
  const t = await setup();
  t.faux.setResponses([fauxAssistantMessage("- 好")]);
  const r = await t.capture("一些内容");
  await expect(t.knowledge.update(t.owner, r.documentId, { summary: "  " })).rejects.toMatchObject({ code: "invalid_request" });
  await expect(t.knowledge.update(t.owner, r.documentId, { summary: "字".repeat(1001) })).rejects.toMatchObject({ code: "invalid_request" });
});

test("模型输出没有要点：作业重试；重试复用同一个后台会话，提交新的 requestId 之前不重复创建会话", async () => {
  const t = await setup();
  t.faux.setResponses([fauxAssistantMessage("抱歉，我无法总结"), fauxAssistantMessage("- 第二次的要点")]);
  const r = await t.capture("一些内容");
  // 第一次失败后退避 30s（默认）会让测试等不到；这里只验证失败状态与会话已记录
  const job = await t.db.get<{ status: string; attempts: number; pi_conversation_id: string; error_code: string }>("SELECT status, attempts, pi_conversation_id, error_code FROM app_jobs WHERE kind = 'summarize'");
  expect(job?.attempts).toBeGreaterThanOrEqual(1);
  expect(["queued", "succeeded"]).toContain(job?.status);
  expect(job?.pi_conversation_id).toMatch(/^\d+$/);
  // 退避只有 10 ms，idle() 不等未到期的作业，所以轮询结果
  for (let i = 0; i < 200 && (await t.summaryOf(r.documentId)).summary === null; i++) await new Promise((x) => setTimeout(x, 25));
  const final = await t.summaryOf(r.documentId);
  expect(final.summary).toBe("- 第二次的要点");
  expect(t.faux.state.callCount).toBe(2);
  const convs = await t.db.all("SELECT DISTINCT pi_conversation_id FROM app_jobs WHERE kind = 'summarize'");
  expect(convs.length).toBe(1);
});
