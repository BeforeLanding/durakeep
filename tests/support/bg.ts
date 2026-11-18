// 摘要 / 后台会话测试的共享装配：真实 PiRuntime + faux、KnowledgeService、JobWorker、BackgroundModel（进程内）。
import { join } from "node:path";
import { systemClock } from "../../packages/core/src/index.ts";
import { guardDb, migrate } from "../../packages/db/src/index.ts";
import { BackgroundModel, JobWorker } from "../../packages/jobs/src/index.ts";
import { ConversationService } from "../../packages/conversations/src/index.ts";
import { ExtractionService, MemoryService } from "../../packages/memory/src/index.ts";
import { BlobStore, createChunkIndexer, KnowledgeService } from "../../packages/knowledge/src/index.ts";
import { openAppDatabase, PiRuntime, startPi } from "../../packages/runtime-pi/src/index.ts";
import { fauxProvider } from "../../packages/runtime-pi/src/testing/faux.ts";

export async function openBg(dir: string, faux: ReturnType<typeof fauxProvider>) {
  const raw = await openAppDatabase(join(dir, "app.sqlite"));
  const db = guardDb(raw);
  await migrate(db);
  const pi = await startPi({ mode: "test", db: raw, faux });
  const rt = new PiRuntime(pi, { model: { provider: "faux", modelId: "faux-1" } });
  const memory = new MemoryService(db, systemClock);
  const background = new BackgroundModel(db, systemClock, () => rt);
  const extraction: ExtractionService = new ExtractionService({ db, clock: systemClock, memory, background, runtime: () => rt, wake: () => worker.wake() });
  const conversations = new ConversationService(db, rt, systemClock);
  const knowledge: KnowledgeService = new KnowledgeService({
    db,
    blobs: new BlobStore(join(dir, "blobs")),
    clock: systemClock,
    indexer: createChunkIndexer(db),
    wake: () => worker.wake(),
    background,
  });
  const worker: JobWorker = new JobWorker(db, systemClock, { ...knowledge.handlers(), ...extraction.handlers() }, { backoffMs: () => 10 });
  await db.run("INSERT OR IGNORE INTO app_owners (id, display_name, timezone, created_at) VALUES ('o1', 'me', 'Asia/Shanghai', 0)");
  return { db, pi, rt, knowledge, worker, memory, extraction, conversations, owner: "o1" };
}
