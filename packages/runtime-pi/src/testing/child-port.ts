// T-06 子进程场景：通过 RuntimePort 验证 R1（入口重发）与 R3（流式输出中崩溃）。
import { fault, readAppMode, type ConversationSnapshot } from "@durakeep/core";
import { migrate } from "@durakeep/db";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PiRuntime } from "../runtime.ts";
import { startPi } from "../start.ts";
import { fauxAssistantMessage, fauxProvider } from "./faux.ts";

const dataDir = process.env.DATA_DIR;
const scenario = process.env.SCENARIO;
if (dataDir === undefined || scenario === undefined) throw new Error("需要 DATA_DIR 和 SCENARIO");
const f = (n: string) => join(dataDir, n);
const out = (o: unknown) => console.log("RESULT " + JSON.stringify(o));

const faux = fauxProvider(scenario.startsWith("r3-first") ? { tokensPerSecond: 15 } : {});
const pi = await startPi({ mode: readAppMode(), dbPath: f("app.sqlite"), faux });
await migrate(pi.db);
const rt = new PiRuntime(pi, { model: { provider: "faux", modelId: "faux-1" } });

// 业务层会把 piConversationId 存进 app_conversations；这里用文件代替
let conv: string;
if (existsSync(f("conv-id"))) conv = readFileSync(f("conv-id"), "utf8");
else {
  conv = (await rt.createConversation({ kind: "chat" })).piConversationId;
  writeFileSync(f("conv-id"), conv);
}
const NOW = Date.UTC(2026, 10, 6, 7, 2); // 2026-11-06 15:02 Asia/Shanghai
const input = { text: "请回答", requestId: "web:req-1", steer: false, now: NOW, tz: "Asia/Shanghai" };

let last: ConversationSnapshot | undefined;
const observer = await rt.observe(conv, undefined, (s) => {
  last = s;
  if (s.live.partialText) fault("model.mid_stream"); // R3：已有部分输出时被杀
});

switch (scenario) {
  case "r1-first": {
    pi.harness.resume();
    await rt.submitInput(conv, input); // 内部在 Pi 接纳之后命中 ingress.after_submit
    break;
  }
  case "r1-second": {
    faux.setResponses([fauxAssistantMessage("完成")]);
    pi.harness.resume();
    const a = await rt.submitInput(conv, input); // 客户端重发
    const b = await rt.submitInput(conv, input);
    const settled = await rt.waitSubmission(a.submissionId);
    await sleep(100);
    const users = last?.entries.filter((e) => e.kind === "user") ?? [];
    out({ same: a.submissionId === b.submissionId, status: settled.status, users: users.length, envelopeOk: undefined });
    break;
  }
  case "r3-first": {
    faux.setResponses([fauxAssistantMessage("这是一段需要流式输出一会儿的较长回答。".repeat(4))]);
    pi.harness.resume();
    const s = await rt.submitInput(conv, input);
    writeFileSync(f("sub-id"), s.submissionId);
    await rt.waitSubmission(s.submissionId);
    out({ error: "没有在流式输出中被杀" });
    break;
  }
  case "r3-second": {
    faux.setResponses([fauxAssistantMessage("完成")]);
    pi.harness.resume();
    const id = readFileSync(f("sub-id"), "utf8");
    const started = Date.now();
    const settled = await rt.waitSubmission(id);
    await sleep(100);
    out({
      status: settled.status,
      reason: settled.status === "unanswered" ? settled.reason : undefined,
      ms: Date.now() - started,
      running: last?.live.running,
      runFailure: last?.live.runFailure,
      callCount: faux.state.callCount,
      assistants: last?.entries.filter((e) => e.kind === "assistant").map((e) => (e.kind === "assistant" ? e.text : "")),
    });
    break;
  }
  default:
    throw new Error(`未知场景：${scenario}`);
}
await observer.stop();
await rt.close();
