// 进程入口（03 §3）：配置 → 实例锁 → 打开数据库 → 迁移 → 知识库与作业队列 → 运行时（含工具）→ 恢复扫描 → resume → HTTP。
// test / demo 模式只用 faux（零费用）；dev / prod 才构造真实 provider（需要 DEEPSEEK_API_KEY）。
import { ConversationDirectory, ConversationService, IngressService } from "@durakeep/conversations";
import { readAppMode, systemClock } from "@durakeep/core";
import { acquireInstanceLock, guardDb, InstanceLockedError, migrate, type InstanceLock } from "@durakeep/db";
import { BackgroundModel, JobWorker } from "@durakeep/jobs";
import { ExtractionService, MemoryService } from "@durakeep/memory";
import { ReminderService, Scheduler } from "@durakeep/reminders";
import { BlobStore, CitationValidator, createChunkIndexer, isPublicIp, KnowledgeRetrieval, KnowledgeService, readPurgeLog, replayPurgeLog, type FetchPolicy } from "@durakeep/knowledge";
import { appCompaction, appCoreExtension, appGuardExtension, appKnowledgeExtension, appMemoryExtension, appProfileExtension, appRemindersExtension, demoFaux, demoScriptedFaux, openAppDatabase, PiRuntime, presentPiReport, startPi } from "@durakeep/runtime-pi";
import { mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { AuthService } from "./auth.ts";
import { DEMO_DOCS } from "./demoData.ts";
import { resolve } from "node:path";
import { createApp, type LogEvent } from "./app.ts";
import { BackupService, startDailyBackup } from "./backup.ts";
import { EventHub } from "./hub.ts";
import { listen } from "./listen.ts";
import { isChatModel, readChatModel } from "./settings.ts";
import { UsageMeter } from "./usage.ts";
import { EventStore } from "./events.ts";

const mode = readAppMode();
// demo：临时数据目录（除非显式指定），固定口令 demo
const dataDir = resolve(process.env.DATA_DIR ?? (mode === "demo" ? mkdtempSync(resolve(tmpdir(), "durakeep-demo-")) : "data"));
const port = Number(process.env.PORT ?? 4777);
const host = "127.0.0.1"; // 只监听 loopback（FR-AUTH-03）
const configuredModel = process.env.CHAT_MODEL;
const chatModel = isChatModel(configuredModel) ? configuredModel : "deepseek-flash";

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

if (mode === "demo" && !(await db.get("SELECT id FROM app_owners LIMIT 1"))) {
  await new AuthService(db, systemClock).initOwner({ password: "demodemo", timezone: "Asia/Shanghai" });
}
const hub = new EventHub();
let healthy = true;
let closing = false;
const ownerId = (await db.get<{ id: string }>("SELECT id FROM app_owners LIMIT 1"))?.id;
const events = new EventStore(db, systemClock);
const storageFailurePath = resolve(dataDir, "storage-failures.jsonl");
if (ownerId) await events.importStorageFailures(storageFailurePath, ownerId);
const pendingReports = new Set<Promise<void>>();
const eventFailure = () => log({ level: "warn", event: "event.write_failed" });

// 采集（T-13）：blob 目录、知识服务、作业队列。抓取策略默认严格；
// 只有 APP_MODE=test 且显式设置 FETCH_ALLOW_LOOPBACK=1 时才放开 127.0.0.1（进程级测试要抓取本机的测试站点）。
const fetchPolicy: Partial<FetchPolicy> | undefined =
  mode === "test" && process.env.FETCH_ALLOW_LOOPBACK === "1" ? { isPublicIp: (ip) => ip === "127.0.0.1" || isPublicIp(ip) } : undefined;
const blobs = new BlobStore(resolve(dataDir, "blobs"));
const purgeLogPath = resolve(dataDir, "purge-log.jsonl");
await replayPurgeLog({ db, blobs, clock: systemClock }, readPurgeLog(purgeLogPath));
const memory = new MemoryService(db, systemClock);
const background = new BackgroundModel(db, systemClock, () => runtime); // 运行时在后面创建；作业在 runtime.resume() 之后才开始领取
const knowledge = new KnowledgeService({
  db,
  blobs,
  clock: systemClock,
  fetchPolicy,
  indexer: createChunkIndexer(db),
  log,
  wake: () => worker.wake(), // worker 在下面创建；wake 只会在它创建之后被调用
  background,
  purgeLogPath,
});
let budgetPaused: boolean | undefined;
const extraction = new ExtractionService({
  db, clock: systemClock, memory, background, runtime: () => runtime, wake: () => worker.wake(),
  ownerId, canScan: () => budgetPaused === false, log,
});
const backup = new BackupService(db, systemClock, dataDir, (path) => runtime.backupInto(path));
const worker = new JobWorker(db, systemClock, { ...knowledge.handlers(), ...extraction.handlers(), backup: backup.handler }, {
  ownerId,
  refreshModelBudget: async () => {
    if (ownerId) await usage.sync(ownerId).catch(onUsageError);
  },
  log,
  onFinished: async (job) => {
    const refs = { job_id: job.id, job_kind: job.kind };
    if (job.status === "failed") await events.record(job.ownerId, "job.failed", "error", refs, "failed").catch(eventFailure);
    if (job.kind === "backup") {
      const succeeded = job.status === "succeeded";
      await events.record(job.ownerId, succeeded ? "backup.done" : "backup.failed", succeeded ? "info" : "error", refs, job.status).catch(eventFailure);
    }
    await knowledge.onJobFinished(job).catch((e: Error) => log({ level: "error", event: "knowledge.on_job_finished", error: e.name }));
    hub.publish({
      ownerId: job.ownerId,
      event: "job",
      data: { id: job.id, kind: job.kind, status: job.status, document_id: (job.input as { documentId?: string }).documentId ?? null },
    });
  },
});
function applyBudgetGate(paused: boolean) {
  if (budgetPaused === paused) return;
  budgetPaused = paused;
  worker.setModelJobsPaused(paused);
  if (paused || closing) extraction.stop();
  else extraction.start();
}
function onUsageError(error: unknown) {
  log({ level: "warn", event: "usage.sync_failed", error: (error as Error).name });
  applyBudgetGate(true);
}

// 运行时：扩展 = AppCore（静态系统提示）+ AppKnowledge（kb_* 工具）+ AppGuard（会话映射与白名单）
const directory = new ConversationDirectory(db); // 只依赖 db：工具与 Guard 按 Pi 会话 ID 找 owner，不必等 ConversationService（它依赖 runtime）
const retrieval = new KnowledgeRetrieval(db);
const reminders = new ReminderService(db, systemClock);
const scheduler = new Scheduler(db, systemClock, (f) => {
  hub.publish({ ownerId: f.ownerId, event: "notification", data: { id: f.notification.id, kind: "reminder", title: f.notification.title, body: f.notification.body, link: f.notification.link } });
  void reminders.unreadCount(f.ownerId).then((count) => hub.publish({ ownerId: f.ownerId, event: "unread", data: { count } }));
  log({ level: "info", event: "reminder.fired", schedule_id: f.scheduleId, late_ms: f.lateMs, catchup: f.catchup });
});
reminders.onChange = () => scheduler.wake();
const useFaux = mode === "test" || mode === "demo";
const pi = await startPi({
  mode,
  db: raw,
  settings: { compaction: appCompaction },
  ...(useFaux ? { faux: mode === "demo" ? demoScriptedFaux() : demoFaux() } : {}),
  extensions: [
    appCoreExtension({ memory: true, reminders: true }),
    appKnowledgeExtension({ db, conversations: directory, knowledge, retrieval }),
    appMemoryExtension({ db, conversations: directory, memory }),
    appProfileExtension({ conversations: directory, memory, onTruncated: (id, revision) => events.profileTruncated(id, revision).catch(eventFailure) }),
    appRemindersExtension({ db, conversations: directory, reminders }),
    appGuardExtension({ conversations: directory }),
  ],
  onReport: (report) => {
    const safe = presentPiReport(report);
    log({ level: safe.report_kind === "storage_failed" ? "error" : "warn", event: "pi.report", ...safe });
    if (ownerId && safe.report_kind !== "storage_failed") {
      const pending = events.recordPi(ownerId, safe).catch(eventFailure).finally(() => pendingReports.delete(pending));
      pendingReports.add(pending);
    }
  },
  onFatal: () => {
    // 03 §6：Harness 失效 → 停止接纳 → 记录 → 退出，由进程管理器拉起；重启后恢复
    healthy = false;
    hub.publish({ ownerId: "*", event: "runtime", data: { status: "failed" } });
    if (ownerId) {
      try {
        events.spoolStorageFailure(storageFailurePath, ownerId);
      } catch {
        eventFailure();
      }
    }
    log({ level: "error", event: "pi.fatal", status: "storage_failed" });
    process.exit(3);
  },
});
const runtime = new PiRuntime(pi, {
  model: useFaux ? { provider: "faux", modelId: "faux-1" } : async () => ({ provider: "deepseek", modelId: await readChatModel(db, chatModel) }),
});
const usage = new UsageMeter(db, systemClock, () => runtime.usage(), hub, (_, paused) => applyBudgetGate(paused));
if (ownerId) await usage.sync(ownerId, true);

const conversations = new ConversationService(db, runtime, systemClock);
const ingress = new IngressService(db, runtime, systemClock, conversations, log);
let orphanedBackgroundConversations = 0;
if (ownerId) {
  const linked = await db.all<{ pi_conversation_id: string }>(
    "SELECT pi_conversation_id FROM app_jobs WHERE owner_id = ? AND pi_conversation_id IS NOT NULL",
    ownerId,
  );
  orphanedBackgroundConversations = await runtime.orphanedBackgroundCount(ownerId, new Set(linked.map((row) => row.pi_conversation_id)));
}
const ingressRecovery = await ingress.recover(); // 先重新派发已接纳未派发的输入
runtime.resume(); // 再继续 Pi 里未完成的 run
const jobsRequeued = await worker.recover(); // 上个进程遗留的 running → queued（03 §5.5）
if (ownerId) await events.record(ownerId, "recovery.scan", ingressRecovery.failed ? "warn" : "info", {
  ingress_redispatched: ingressRecovery.redispatched, ingress_failed: ingressRecovery.failed, jobs_requeued: jobsRequeued,
  orphaned_background_conversations: orphanedBackgroundConversations,
}, ingressRecovery.failed ? "partial" : "done").catch(eventFailure);
worker.start(); // 后台作业要用运行时，所以在它就绪之后才开始领取
const stopUsage = ownerId ? usage.start(ownerId, onUsageError) : undefined;

const webDist = resolve(import.meta.dirname, "../../web/dist");
const { app } = createApp({
  db,
  clock: systemClock,
  origin: `http://${host}:${port}`,
  isHealthy: () => healthy,
  chat: { conversations, ingress, runtime },
  knowledge,
  memory,
  reminders,
  citations: new CitationValidator(db),
  wakeJobs: () => worker.wake(),
  backup,
  usage,
  chatModel,
  events,
  orphanedBackgroundConversations,
  runbookPath: resolve(import.meta.dirname, "../../../docs/runbook.md"),
  hub,
  ...(existsSync(webDist) ? { staticDir: webDist } : {}),
  log,
});
if (mode === "demo") {
  const owner = (await db.get<{ id: string }>("SELECT id FROM app_owners LIMIT 1"))!;
  for (const [i, d] of DEMO_DOCS.entries()) {
    await knowledge.captureText(owner.id, { clientRequestId: `00000000-0000-4000-8000-00000000000${i}`, kind: "markdown", title: d.title, text: d.text, tags: d.tags }).catch(() => {});
  }
  log({ level: "info", event: "demo.ready", hint: "口令 demodemo" });
}
scheduler.start(); // 启动时先补发已到期的提醒（FR-REM-04），再按下一次到期时间设置定时器
const stopDailyBackup = startDailyBackup(systemClock, backup, () => worker.wake(), (error) => {
  log({ level: "error", event: "backup.schedule_failed", error: (error as Error).name });
  if (ownerId) void events.record(ownerId, "backup.failed", "error", {}, "schedule_failed").catch(eventFailure);
});
const server = await listen(app.fetch, { host, port });
log({ level: "info", event: "listening", port: server.port, mode });

async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  log({ level: "info", event: "shutdown", signal });
  await server.close();
  await stopUsage?.();
  extraction.stop();
  await stopDailyBackup();
  await scheduler.stop();
  await worker.stop(); // 等待执行中的作业结束
  if (ownerId) await usage.sync(ownerId).catch(onUsageError);
  await Promise.all(pendingReports);
  await runtime.close(); // 等待任务代码返回，并关闭共享连接
  lock.release();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
