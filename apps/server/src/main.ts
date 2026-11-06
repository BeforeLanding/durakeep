// 进程入口（03 §3）：配置 → 实例锁 → 打开数据库 → 迁移 → 知识库与作业队列 → 运行时（含工具）→ 恢复扫描 → resume → HTTP。
// test / demo 模式只用 faux（零费用）；dev / prod 才构造真实 provider（需要 DEEPSEEK_API_KEY）。
import { ConversationDirectory, ConversationService, IngressService } from "@durakeep/conversations";
import { readAppMode, systemClock } from "@durakeep/core";
import { acquireInstanceLock, guardDb, InstanceLockedError, migrate, type InstanceLock } from "@durakeep/db";
import { JobWorker } from "@durakeep/jobs";
import { BlobStore, createChunkIndexer, isPublicIp, KnowledgeRetrieval, KnowledgeService, type FetchPolicy } from "@durakeep/knowledge";
import { appCoreExtension, appGuardExtension, appKnowledgeExtension, demoFaux, openAppDatabase, PiRuntime, startPi } from "@durakeep/runtime-pi";
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

const hub = new EventHub();
let healthy = true;

// 采集（T-13）：blob 目录、知识服务、作业队列。抓取策略默认严格；
// 只有 APP_MODE=test 且显式设置 FETCH_ALLOW_LOOPBACK=1 时才放开 127.0.0.1（进程级测试要抓取本机的测试站点）。
const fetchPolicy: Partial<FetchPolicy> | undefined =
  mode === "test" && process.env.FETCH_ALLOW_LOOPBACK === "1" ? { isPublicIp: (ip) => ip === "127.0.0.1" || isPublicIp(ip) } : undefined;
const knowledge = new KnowledgeService({
  db,
  blobs: new BlobStore(resolve(dataDir, "blobs")),
  clock: systemClock,
  fetchPolicy,
  indexer: createChunkIndexer(db),
  log,
  wake: () => worker.wake(), // worker 在下面创建；wake 只会在它创建之后被调用
});
const worker = new JobWorker(db, systemClock, knowledge.handlers(), {
  log,
  onFinished: async (job) => {
    await knowledge.onJobFinished(job).catch((e: Error) => log({ level: "error", event: "knowledge.on_job_finished", error: e.name }));
    hub.publish({
      ownerId: job.ownerId,
      event: "job",
      data: { id: job.id, kind: job.kind, status: job.status, document_id: (job.input as { documentId?: string }).documentId ?? null },
    });
  },
});
await worker.recover(); // 上个进程遗留的 running → queued（03 §5.5）
worker.start();

// 运行时：扩展 = AppCore（静态系统提示）+ AppKnowledge（kb_* 工具）+ AppGuard（会话映射与白名单）
const directory = new ConversationDirectory(db); // 只依赖 db：工具与 Guard 按 Pi 会话 ID 找 owner，不必等 ConversationService（它依赖 runtime）
const retrieval = new KnowledgeRetrieval(db);
const useFaux = mode === "test" || mode === "demo";
const pi = await startPi({
  mode,
  db: raw,
  ...(useFaux ? { faux: demoFaux() } : {}),
  extensions: [appCoreExtension(), appKnowledgeExtension({ db, conversations: directory, knowledge, retrieval }), appGuardExtension({ conversations: directory })],
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

const { app } = createApp({
  db,
  clock: systemClock,
  origin: `http://${host}:${port}`,
  isHealthy: () => healthy,
  chat: { conversations, ingress, runtime },
  knowledge,
  wakeJobs: () => worker.wake(),
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
  await worker.stop(); // 等待执行中的作业结束
  await runtime.close(); // 等待任务代码返回，并关闭共享连接
  lock.release();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
