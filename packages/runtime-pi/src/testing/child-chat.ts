// 子进程场景：用 faux 跑通一轮“工具调用 + 回答”，在故障点可被 SIGKILL。
// 环境变量：DATA_DIR、SCENARIO、FAULT_POINT / FAULT_HIT（来自 core/fault.ts）。
// 标准输出：以 "RESULT " 开头的一行 JSON。
import { fault, readAppMode } from "@durakeep/core";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { context, startPi } from "../start.ts";

const dataDir = process.env.DATA_DIR;
if (dataDir === undefined) throw new Error("DATA_DIR 未设置");
const executeLog = join(dataDir, "tool-executions.log");

const echo = defineTool({
  name: "echo",
  description: "原样返回文本",
  parameters: obj({ text: str() }),
  replay: "safe",
  callers: ["model"],
  execute: async (args) => {
    appendFileSync(executeLog, `${args.text}\n`);
    fault("tool.in_execute");
    return { output: [{ type: "text", text: `echo:${args.text}` }] };
  },
});
const ext = defineExtension({
  name: "t01",
  tools: [echo],
  sections: [section("preamble", () => "你是测试助手。", { tag: false })],
});

const faux = fauxProvider();
const mode = readAppMode();
const pi = await startPi({ mode, dbPath: join(dataDir, "app.sqlite"), faux, extensions: [ext] });
const root = await pi.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

if (process.env.SCENARIO === "first") {
  // 第一次启动：模型先调用工具；工具内命中故障点则进程被杀。
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("完成"),
  ]);
} else {
  // 恢复后：工具调用已提交，只需要最后一次模型请求。
  faux.setResponses([fauxAssistantMessage("完成")]);
}

pi.harness.resume();
const sub = await root.submit({ type: "input", content: "请调用 echo", requestId: "r1" }, context);
const settled = await sub.wait(context);
const page = await root.entries({}, 50, undefined, context);
const kinds = [...page.items].reverse().map((e) => e.kind);
console.log(
  "RESULT " +
    JSON.stringify({ status: settled.status, kinds, callCount: faux.state.callCount, submissionId: sub.id }),
);
await pi.close();
