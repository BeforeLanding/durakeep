// R2 子进程场景：写工具在“业务已提交、结果未交给 Pi”之间被 SIGKILL，重启后重跑。
import { readAppMode } from "@durakeep/core";
import { migrate } from "@durakeep/db";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { context, startPi } from "../start.ts";
import { writeSpikeExtension } from "../write-tool-spike.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "./faux.ts";

const dataDir = process.env.DATA_DIR;
if (dataDir === undefined) throw new Error("DATA_DIR 未设置");
const faux = fauxProvider();
const pi = await startPi({
  mode: readAppMode(),
  dbPath: join(dataDir, "app.sqlite"),
  faux,
  extensionsFactory: (db) => [
    writeSpikeExtension(db, (e) => appendFileSync(join(dataDir, "tool.log"), JSON.stringify(e) + "\n")),
  ],
});
await migrate(pi.db);
const root = await pi.harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });

faux.setResponses(
  process.env.SCENARIO === "first"
    ? [
        fauxAssistantMessage(fauxToolCall("probe_write", { text: " x " }), { stopReason: "toolUse" }),
        fauxAssistantMessage("完成"),
      ]
    : [fauxAssistantMessage("完成")],
);
pi.harness.resume();
const sub = await root.submit({ type: "input", content: "请写入 x", requestId: "r2" }, context);
const settled = await sub.wait(context);
const rows = await pi.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_probe WHERE note = 'x'");
const ops = await pi.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_operations");
console.log(
  "RESULT " +
    JSON.stringify({ status: settled.status, probeRows: rows?.c, opRows: ops?.c, callCount: faux.state.callCount }),
);
await pi.close();
