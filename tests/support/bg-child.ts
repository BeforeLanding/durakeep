// R14 子进程：第一次在 background.after_answer 被杀；第二次恢复后摘要应写回且 faux 不再被调用。
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "../../packages/runtime-pi/src/testing/faux.ts";
import { openBg } from "./bg.ts";

const dir = process.env.DATA_DIR!;
const scenario = process.env.SCENARIO!;
const faux = fauxProvider();
const s = await openBg(dir, faux);
void join;

if (scenario === "first") {
  faux.setResponses([fauxAssistantMessage("- 第一次的要点")]);
  s.pi.harness.resume();
  s.worker.start();
  await s.knowledge.captureText(s.owner, { clientRequestId: "00000000-0000-4000-8000-000000000001", kind: "markdown", title: "t", text: "崩溃恢复相关的内容" });
  await new Promise((r) => setTimeout(r, 15_000)); // 正常情况下在此之前已被杀
  console.log("RESULT " + JSON.stringify({ error: "没有被杀" }));
} else {
  faux.setResponses([fauxAssistantMessage("- 不应该出现的第二次回答")]);
  s.pi.harness.resume();
  await s.worker.recover();
  s.worker.start();
  let row: { summary: string | null } | undefined;
  for (let i = 0; i < 400; i++) {
    row = await s.db.get("SELECT summary FROM app_document_versions");
    if (row?.summary) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const jobs = await s.db.all<{ status: string; attempts: number; pi_conversation_id: string }>("SELECT status, attempts, pi_conversation_id FROM app_jobs WHERE kind = 'summarize'");
  console.log("RESULT " + JSON.stringify({ summary: row?.summary ?? null, callCount: faux.state.callCount, jobs }));
}
await s.worker.stop();
await s.rt.close();
process.exit(0);
