// 进程入口（03 §3 的前半：配置 → 实例锁 → 打开数据库 → 迁移 → HTTP）。
// 运行时（PiRuntime）与恢复扫描在 T-11 接入。
import { readAppMode, systemClock } from "@durakeep/core";
import { acquireInstanceLock, guardDb, InstanceLockedError, migrate, type InstanceLock } from "@durakeep/db";
import { openAppDatabase } from "@durakeep/runtime-pi";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, type LogEvent } from "./app.ts";
import { listen } from "./listen.ts";

const mode = readAppMode();
const dataDir = resolve(process.env.DATA_DIR ?? "data");
const port = Number(process.env.PORT ?? 4777);
const host = "127.0.0.1"; // 只监听 loopback（FR-AUTH-03）

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

const { app } = createApp({ db, clock: systemClock, origin: `http://${host}:${port}`, log });
const server = await listen(app.fetch, { host, port });
log({ level: "info", event: "listening", port: server.port, mode });

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log({ level: "info", event: "shutdown", signal });
  await server.close();
  await db.close();
  lock.release();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
