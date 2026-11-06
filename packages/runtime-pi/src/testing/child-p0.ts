// T-05 子进程场景（R8、R15、R16、K3）。环境变量：DATA_DIR、SCENARIO，以及故障注入的 FAULT_POINT / FAULT_HIT。
// 标准输出以 "RESULT " 开头的一行 JSON；退出码：0 正常，3 因 harness 失效而退出，5 实例锁被占用。
import { fault, readAppMode } from "@durakeep/core";
import { acquireInstanceLock, backupInto, InstanceLockedError, migrate } from "@durakeep/db";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { context, startPi } from "../start.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "./faux.ts";

const dataDir = process.env.DATA_DIR;
const scenario = process.env.SCENARIO;
if (dataDir === undefined || scenario === undefined) throw new Error("需要 DATA_DIR 和 SCENARIO");
const f = (name: string) => join(dataDir, name);
const out = (o: unknown) => console.log("RESULT " + JSON.stringify(o));
const model = { provider: "faux", modelId: "faux-1" } as const;

// ---- 实例锁（R16）----
let lock;
try {
  lock = acquireInstanceLock(dataDir);
} catch (e) {
  if (e instanceof InstanceLockedError) {
    out({ locked: true, holder: e.pid });
    process.exit(5);
  }
  throw e;
}

// ---- 工具 ----
const echo = defineTool({
  name: "echo",
  description: "原样返回文本",
  parameters: obj({ text: str() }),
  replay: "safe",
  callers: ["model"],
  execute: async (args) => {
    appendFileSync(f("tool-executions.log"), `${args.text}\n`);
    fault("tool.in_execute");
    return { output: [{ type: "text", text: `echo:${args.text}` }] };
  },
});

const reports: string[] = [];
const faux = fauxProvider();
const pi = await startPi({
  mode: readAppMode(),
  dbPath: f("app.sqlite"),
  faux,
  onReport: (r) => {
    reports.push(r.kind);
    appendFileSync(f("reports.log"), `${r.kind}\n`);
  },
  onFatal: (error) => {
    appendFileSync(f("fatal.log"), `${(error as Error).name ?? "error"}\n`);
    process.exit(3); // 宿主策略：存储失败 → 退出进程，重启后恢复
  },
  extensionsFactory: (db) => [
    defineExtension({
      name: "t05",
      sections: [section("preamble", () => "你是测试助手。", { tag: false })],
      tools: [
        echo,
        defineTool({
          name: "slow_write",
          description: "写入一行探测记录，然后（K3）等待备份完成",
          parameters: obj({ text: str() }),
          replay: "safe",
          callers: ["model"],
          execute: async (args) => {
            const have = await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_probe WHERE note = ?", args.text);
            if (!have || have.c === 0) await db.run("INSERT INTO app_probe (owner_id, n, note) VALUES (?, ?, ?)", "o1", 0, args.text);
            if (process.env.WAIT_BACKUP === "1") {
              writeFileSync(f("tool-started"), "1");
              while (!existsSync(f("backup-done"))) await sleep(10);
            }
            return { output: [{ type: "text", text: "写入完成" }] };
          },
        }),
      ],
    }),
  ],
});
await migrate(pi.db);
const root = await pi.harness.root(context, { agent: { model } });

const toolRound = (name: string, text: string) =>
  fauxAssistantMessage(fauxToolCall(name, { text }), { stopReason: "toolUse" });
const done = fauxAssistantMessage("完成");

async function summary(sub: { id: number | string }, status: string) {
  const page = await root.entries({}, 100, undefined, context);
  const items = [...page.items].reverse();
  const toolResults = items
    .filter((e) => e.kind === "pi.tool-result")
    .map((e) => JSON.stringify(e.model?.[0] ?? null).slice(0, 300));
  const probe = await pi.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_probe WHERE note = 'x'");
  return { status, kinds: items.map((e) => e.kind), toolResults, probeRows: probe?.c, callCount: faux.state.callCount, reports, submissionId: String(sub.id) };
}

switch (scenario) {
  case "r8-first": {
    faux.setResponses([done]);
    pi.harness.resume();
    const sub = await root.submit({ type: "input", content: "请回答", requestId: "r8" }, context);
    // 输入已被接纳（已提交）。之后让所有写入失败，模拟存储故障（只读 / 磁盘满）。
    await pi.db.exec("PRAGMA query_only = ON");
    try {
      await sub.wait(context);
    } catch {
      /* SessionFailed：等待 onFatal 退出进程 */
    }
    await sleep(3000);
    out({ error: "harness 失效后进程没有退出" });
    process.exit(4);
    break;
  }
  case "r8-second":
  case "r15-first":
  case "r15-next": {
    if (scenario === "r15-first") faux.setResponses([toolRound("echo", "hi"), done]);
    else faux.setResponses([done]);
    pi.harness.resume();
    const sub = await root.submit({ type: "input", content: "请回答", requestId: scenario.startsWith("r8") ? "r8" : "r15" }, context);
    const settled = await sub.wait(context);
    out(await summary(sub, settled.status));
    await pi.close();
    break;
  }
  case "r16-hold": {
    writeFileSync(f("holder-ready"), "1");
    while (!existsSync(f("holder-release"))) await sleep(10);
    faux.setResponses([done]);
    pi.harness.resume();
    const sub = await root.submit({ type: "input", content: "请回答", requestId: "r16" }, context);
    const settled = await sub.wait(context);
    out(await summary(sub, settled.status));
    await pi.close();
    break;
  }
  case "k3-first": {
    faux.setResponses([toolRound("slow_write", "x"), done]);
    pi.harness.resume();
    const sub = await root.submit({ type: "input", content: "请写入", requestId: "k3" }, context);
    while (!existsSync(f("tool-started"))) await sleep(10);
    const target = process.env.BACKUP_DIR;
    if (target === undefined) throw new Error("需要 BACKUP_DIR");
    await backupInto(pi.db, join(target, "app.sqlite")); // run 进行中、工具执行中
    writeFileSync(f("backup-done"), "1");
    const settled = await sub.wait(context);
    out(await summary(sub, settled.status));
    await pi.close();
    break;
  }
  case "k3-copy": {
    faux.setResponses([done]);
    pi.harness.resume();
    const integrity = await pi.db.get<{ integrity_check: string }>("PRAGMA integrity_check");
    const sub = await root.submit({ type: "input", content: "请写入", requestId: "k3" }, context);
    const settled = await sub.wait(context);
    out({ ...(await summary(sub, settled.status)), integrity: integrity?.integrity_check });
    await pi.close();
    break;
  }
  default:
    throw new Error(`未知场景：${scenario}`);
}
lock.release();
