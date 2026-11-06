// 进程入口（03 §3）：配置 → 实例锁 → 打开数据库 → 迁移 → 运行时 → 恢复扫描 → resume → HTTP。
// test / demo 模式只用 faux（零费用）；dev / prod 才构造真实 provider（需要 DEEPSEEK_API_KEY）。
import { ConversationService, IngressService } from "@durakeep/conversations";
import { readAppMode, systemClock } from "@durakeep/core";
import { acquireInstanceLock, guardDb, InstanceLockedError, migrate, type InstanceLock } from "@durakeep/db";
import { demoFaux, openAppDatabase, PiRuntime, startPi } from "@durakeep/runtime-pi";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, type LogEvent } from "./app.ts";
import { EventHub } from "./hub.ts";
import { listen } from "./listen.ts";

const mode = readAppMode();
const dataDir = resolve(process.env.DATA_DIR ?? "data");
const port = Number(process.env.PORT ?? 4777);
const host = "127.0.0.1"; // 只监听 loopback（FR-AUTH-03）
const chatModel = process.env.CHAT_MODEL ?? "deepseek-flash";

const log = (e: LogEvent) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...e }));

mkdirSync(dataDir, { recursive: true });
let lock: InstanceLock;
try {
  lock = acquireInstanceLock(dataDir);
} catch (e) {
  if (e instanceof InstanceLockedError) {
    log({ level: "error", event: "instance_locked", pid: e.pid });
    process.exit(1);
  }
  throw e;
}

const raw = await openAppDatabase(resolve(dataDir, "app.sqlite"));
const db = guardDb(raw);
await migrate(db);

let healthy = true;
const useFaux = mode === "test" || mode === "demo";
const pi = await startPi({
  mode,
  db: raw,
  ...(useFaux ? { faux: demoFaux() } : {}),
  onReport: (r) => log({ level: r.kind === "storage_failed" ? "error" : "warn", event: "pi.report", kind: r.kind }),
  onFatal: (error) => {
    // 03 §6：Harness 失效 → 停止接纳 → 记录 → 退出，由进程管理器拉起；重启后恢复
    healthy = false;
    hub.publish({ ownerId: "*", event: "runtime", data: { status: "failed" } });
    log({ level: "error", event: "pi.fatal", error: (error as Error).name });
    process.exit(3);
  },
});
const runtime = new PiRuntime(pi, {
  model: useFaux ? { provider: "faux", modelId: "faux-1" } : { provider: "deepseek", modelId: chatModel },
});

const conversations = new ConversationService(db, runtime, systemClock);
const ingress = new IngressService(db, runtime, systemClock, conversations, log);
await ingress.recover(); // 先重新派发已接纳未派发的输入
runtime.resume(); // 再继续 Pi 里未完成的 run

const hub = new EventHub();
const { app } = createApp({
  db,
  clock: systemClock,
  origin: `http://${host}:${port}`,
  isHealthy: () => healthy,
  chat: { conversations, ingress, runtime },
  hub,
  log,
});
const server = await listen(app.fetch, { host, port });
log({ level: "info", event: "listening", port: server.port, mode });

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log({ level: "info", event: "shutdown", signal });
  await server.close();
  await runtime.close(); // 等待任务代码返回，并关闭共享连接
  lock.release();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
