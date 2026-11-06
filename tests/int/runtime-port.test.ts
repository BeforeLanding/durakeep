// RuntimePort 的最小实现：create → submit → observe → wait → abort（进程内，faux）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ConversationSnapshot } from "../../packages/core/src/index.ts";
import { migrate } from "../../packages/db/src/index.ts";
import { PiRuntime, formatEnvelopeTime, startPi } from "../../packages/runtime-pi/src/index.ts";
import { fauxAssistantMessage, fauxProvider } from "../../packages/runtime-pi/src/testing/faux.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const NOW = Date.UTC(2026, 10, 6, 7, 2);
const model = { provider: "faux", modelId: "faux-1" } as const;

async function open() {
  const dir = mkdtempSync(join(tmpdir(), "durakeep-port-"));
  dirs.push(dir);
  const faux = fauxProvider();
  const pi = await startPi({ mode: "test", dbPath: join(dir, "app.sqlite"), faux });
  await migrate(pi.db);
  return { faux, pi, rt: new PiRuntime(pi, { model }), dir };
}

test("信封时间格式（ADR-09）", () => {
  expect(formatEnvelopeTime(NOW, "Asia/Shanghai")).toBe("2026-11-06 15:02 星期五 Asia/Shanghai");
  expect(formatEnvelopeTime(NOW, "America/New_York")).toBe("2026-11-06 02:02 星期五 America/New_York");
});

test("create → submit → observe → wait：界面只见原话，模型见信封；usage / backup 可用", async () => {
  const { faux, rt, dir, pi } = await open();
  let seen = "";
  faux.setResponses([
    (requestContext) => {
      seen = JSON.stringify(requestContext);
      return fauxAssistantMessage("你好，已收到。");
    },
  ]);
  const { piConversationId: conv } = await rt.createConversation({ kind: "chat" });
  const snaps: ConversationSnapshot[] = [];
  const obs = await rt.observe(conv, undefined, (s) => snaps.push(s));
  pi.harness.resume();
  const { submissionId } = await rt.submitInput(conv, { text: "你好", requestId: "web:1", steer: false, now: NOW, tz: "Asia/Shanghai" });
  const settled = await rt.waitSubmission(submissionId);
  expect(settled).toEqual({ status: "done", answerText: "你好，已收到。" });
  await new Promise((r) => setTimeout(r, 100));
  const last = snaps.at(-1)!;
  expect(last.entries.map((e) => e.kind)).toEqual(["user", "assistant"]);
  expect(last.entries[0]).toMatchObject({ kind: "user", text: "你好", tz: "Asia/Shanghai" }); // 不含信封
  expect(last.live.running).toBe(false);
  expect(obs.cursor()).toBeDefined();
  // 模型看到的是带时间的信封
  expect(seen).toContain("[当前时间 2026-11-06 15:02 星期五 Asia/Shanghai]");
  expect(seen).toContain("你好");
  expect(Object.keys(await rt.usage())).toEqual(["models", "tools"]);
  await rt.backupInto(join(dir, "backup.sqlite"));
  await obs.stop();
  await rt.close();
});

test("同 requestId 重发返回同一个 submission；continue 在空闲且无失败可续时 unanswered；abort 可调用", async () => {
  const { faux, rt, pi } = await open();
  faux.setResponses([fauxAssistantMessage("好")]);
  const { piConversationId: conv } = await rt.createConversation({ kind: "chat" });
  pi.harness.resume();
  const input = { text: "问", requestId: "web:dup", steer: false, now: NOW, tz: "UTC" };
  const a = await rt.submitInput(conv, input);
  const b = await rt.submitInput(conv, input);
  expect(b.submissionId).toBe(a.submissionId);
  await rt.waitSubmission(a.submissionId);
  const c = await rt.submitContinue(conv);
  const r = await rt.waitSubmission(c.submissionId);
  expect(r).toMatchObject({ status: "unanswered", reason: "nothing_to_answer" });
  await rt.abort(conv);
  await rt.close();
});
