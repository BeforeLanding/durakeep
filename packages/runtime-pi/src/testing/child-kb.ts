// T-15 子进程场景：kb_capture_text / kb_capture_url 在“业务已提交、结果未交给 Pi”之间被 SIGKILL，重启后工具重跑（R2）。
// 环境变量：DATA_DIR、SCENARIO（first | second）、TOOL（text | url）、FAULT_POINT / FAULT_HIT。
import { ConversationDirectory, ConversationService } from "@durakeep/conversations";
import { readAppMode, systemClock } from "@durakeep/core";
import { guardDb, migrate } from "@durakeep/db";
import { BlobStore, KnowledgeRetrieval, KnowledgeService } from "@durakeep/knowledge";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appCoreExtension, appGuardExtension, appKnowledgeExtension } from "../index.ts";
import { PiRuntime } from "../runtime.ts";
import { context, openAppDatabase, startPi } from "../start.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "./faux.ts";

const dataDir = process.env.DATA_DIR;
if (dataDir === undefined) throw new Error("DATA_DIR 未设置");
const f = (n: string) => join(dataDir, n);

const raw = await openAppDatabase(f("app.sqlite"));
const db = guardDb(raw);
await migrate(db);
await db.run("INSERT OR IGNORE INTO app_owners (id, display_name, timezone, created_at) VALUES ('o1', 'x', 'UTC', 1)");

const knowledge = new KnowledgeService({ db, blobs: new BlobStore(f("blobs")), clock: systemClock });
const directory = new ConversationDirectory(db);
const faux = fauxProvider();
const pi = await startPi({
  mode: readAppMode(),
  db: raw,
  faux,
  extensions: [appCoreExtension(), appKnowledgeExtension({ db, conversations: directory, knowledge, retrieval: new KnowledgeRetrieval(db) }), appGuardExtension({ conversations: directory })],
});
const runtime = new PiRuntime(pi, { model: { provider: "faux", modelId: "faux-1" } });
const conversations = new ConversationService(db, runtime, systemClock);

let convId: string;
if (existsSync(f("conv-id"))) convId = readFileSync(f("conv-id"), "utf8");
else {
  convId = (await conversations.create("o1")).id;
  writeFileSync(f("conv-id"), convId);
}
const conv = await conversations.get("o1", convId);

const tool = process.env.TOOL === "url" ? "kb_capture_url" : "kb_capture_text";
const args: Record<string, string | string[]> = tool === "kb_capture_url" ? { url: "https://example.com/崩溃测试?utm_source=x", tags: ["t"] } : { title: "崩溃测试", text: "需要保存的内容，用来验证崩溃后只保存一次。", tags: ["t"] };
faux.setResponses(
  process.env.SCENARIO === "first"
    ? [fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" }), fauxAssistantMessage("完成")]
    : [fauxAssistantMessage("完成")],
);
runtime.resume();
const sub = await runtime.submitInput(conv.piConversationId, { text: "请保存", requestId: "r-kb", steer: false, now: Date.now(), tz: "UTC" });
const settled = await runtime.waitSubmission(sub.submissionId);

const c = await pi.harness.conversation(Number(conv.piConversationId) as never, context);
const page = await c!.entries({}, 50, undefined, context);
const results = [...page.items]
  .reverse()
  .filter((e) => e.kind === "pi.tool-result")
  .map((e) => (e.model![0] as { content: { text: string }[] }).content.map((x) => x.text).join(""));
const one = async (sql: string) => ((await db.get<{ c: number }>(sql))?.c ?? -1) as number;
console.log(
  "RESULT " +
    JSON.stringify({
      status: settled.status,
      docs: await one("SELECT COUNT(*) AS c FROM app_documents"),
      jobs: await one("SELECT COUNT(*) AS c FROM app_jobs"),
      ops: await one("SELECT COUNT(*) AS c FROM app_operations"),
      results,
      callCount: faux.state.callCount,
    }),
);
await runtime.close();
