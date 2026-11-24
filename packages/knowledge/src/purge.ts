// 资料“彻底删除”（FR-KB-08、07 §6、04 §4.1）。
// 请求时同一个事务里：状态 → purging、片段全部不可检索、取消该资料的排队 / 运行中作业、入队 purge_document。
// 作业分阶段（每步可重入）：等同资料的其他作业退出 → 记下要删的 blob → 追加 purge-log → 事务清理 DB → 删除 blob（仍被引用的保留）。
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Clock } from "@durakeep/core";
import type { SqlDatabase } from "@durakeep/db";
import { enqueue, getJob, JobError, type JobContext, type JobHandler } from "@durakeep/jobs";
import type { BlobStore } from "./blob.ts";
import { getDocument } from "./documents.ts";
import { deleteVersionChunks, setActiveChunks } from "./indexer.ts";

const SIBLING_KINDS = "'ingest_text','ingest_url','summarize'";

export type PurgeDeps = { db: SqlDatabase; blobs: BlobStore; clock: Clock; logPath?: string; wake?: () => void };

export type PurgeLog = Map<string, Set<string>>;

export function readPurgeLog(path: string): PurgeLog {
  let log: string;
  try {
    log = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw e;
  }
  const documents: PurgeLog = new Map();
  for (const line of log.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { owner_id?: unknown; document_id?: unknown } | null;
    if (typeof record?.owner_id !== "string" || typeof record.document_id !== "string" || !record.owner_id || !record.document_id) {
      throw new Error("purge-log.jsonl 包含无效记录");
    }
    const ids = documents.get(record.owner_id) ?? new Set<string>();
    ids.add(record.document_id);
    documents.set(record.owner_id, ids);
  }
  return documents;
}

/** 在任何作业、对话和 HTTP 开始前完成重放，沿用原删除流程和持久化检查点。 */
export async function replayPurgeLog(d: PurgeDeps, documents: PurgeLog): Promise<void> {
  for (const [ownerId, ids] of documents) {
    for (const documentId of ids) {
      const doc = await d.db.get<{ status: string }>("SELECT status FROM app_documents WHERE owner_id = ? AND id = ?", ownerId, documentId);
      if (!doc) continue;
      const existing = await d.db.get<{ id: string; status: string }>(
        "SELECT id, status FROM app_jobs WHERE owner_id = ? AND kind = 'purge_document' AND dedupe_key = ?",
        ownerId, `purge_document:${documentId}`,
      );
      if (doc.status === "purged" && (!existing || existing.status === "succeeded")) continue;
      const jobId = doc.status === "purged" ? existing!.id : (await requestPurge(d, ownerId, documentId)).jobId;
      const job = await getJob(d.db, ownerId, jobId);
      const checkpoint = { ...job.checkpoint, settled: true, logged: true };
      await runPurge(d, {
        job,
        checkpoint,
        async save(patch) {
          Object.assign(checkpoint, patch);
          await d.db.run("UPDATE app_jobs SET checkpoint_json = ?, updated_at = ? WHERE owner_id = ? AND id = ?", JSON.stringify(checkpoint), d.clock.now(), ownerId, jobId);
        },
      });
      await d.db.run("UPDATE app_jobs SET status = 'succeeded', error_code = NULL, error_message = NULL, updated_at = ? WHERE owner_id = ? AND id = ?", d.clock.now(), ownerId, jobId);
    }
  }
}

/** 请求彻底删除。幂等：已在删除中时返回同一个作业。 */
export async function requestPurge(d: PurgeDeps, ownerId: string, documentId: string): Promise<{ documentId: string; jobId: string }> {
  const now = d.clock.now();
  const out = await d.db.transaction(async (tx) => {
    const doc = await getDocument(tx, ownerId, documentId); // purged → 404
    await tx.run("UPDATE app_documents SET status = 'purging', updated_at = ? WHERE owner_id = ? AND id = ?", now, ownerId, documentId);
    await setActiveChunks(tx, ownerId, documentId, doc.currentVersionId, false); // 立即不可检索、引用校验也立即失效
    // 该资料尚未结束的采集 / 摘要作业：取消，运行中的在下一个检查点放弃（purge 作业还会等它们退出）
    await tx.run(
      `UPDATE app_jobs SET status = 'cancelled', updated_at = ?
        WHERE owner_id = ? AND status IN ('queued','running') AND kind IN (${SIBLING_KINDS}) AND json_extract(input_json, '$.documentId') = ?`,
      now,
      ownerId,
      documentId,
    );
    const { job } = await enqueue(tx, now, { ownerId, kind: "purge_document", dedupeKey: `purge_document:${documentId}`, input: { documentId } });
    return job.id;
  });
  d.wake?.();
  return { documentId, jobId: out };
}

export function purgeHandler(d: PurgeDeps): JobHandler {
  return (ctx) => runPurge(d, ctx);
}

async function runPurge(d: PurgeDeps, ctx: JobContext): Promise<void> {
  const { job } = ctx;
  const ownerId = job.ownerId;
  const documentId = (job.input as { documentId: string }).documentId;
  const doc = await d.db.get<{ status: string }>("SELECT status FROM app_documents WHERE owner_id = ? AND id = ?", ownerId, documentId);
  if (!doc) throw new JobError("not_found", "资料不存在", false);

  // 1. 等同一份资料的其他作业退出：否则正在运行的采集可能在清理之后又写进片段
  if (ctx.checkpoint.settled !== true) {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const busy = await d.db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM app_jobs WHERE owner_id = ? AND status = 'running' AND kind IN (${SIBLING_KINDS}) AND json_extract(input_json, '$.documentId') = ?`,
        ownerId,
        documentId,
      );
      if ((busy?.c ?? 0) === 0) break;
      if (Date.now() > deadline) throw new JobError("busy", "资料还有作业在运行，稍后重试", true);
      await new Promise((r) => setTimeout(r, 100));
    }
    await ctx.save({ settled: true });
  }

  // 2. 记下要删的 blob（DB 清理之后哈希就没了）
  let blobs = ctx.checkpoint.blobs as string[] | undefined;
  if (!blobs) {
    const vs = await d.db.all<{ raw_blob: string; text_blob: string | null }>(
      "SELECT raw_blob, text_blob FROM app_document_versions WHERE owner_id = ? AND document_id = ? AND status != 'purged'",
      ownerId,
      documentId,
    );
    blobs = [...new Set(vs.flatMap((v) => [v.raw_blob, v.text_blob]).filter((h): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)))];
    await ctx.save({ blobs });
  }

  // 3. 追加 purge-log：只记 ID 与时间。先记后删——崩溃在中间最多多一行（重放是幂等的）
  if (ctx.checkpoint.logged !== true) {
    if (d.logPath) {
      mkdirSync(dirname(d.logPath), { recursive: true });
      appendFileSync(d.logPath, JSON.stringify({ at: d.clock.now(), owner_id: ownerId, document_id: documentId, job_id: job.id }) + "\n", { flush: true });
    }
    await ctx.save({ logged: true });
  }

  // 4. 事务清理：片段与 FTS 行、摘要、blob 引用、可识别来源；只留墓碑（id、标题、purged_at）
  const now = d.clock.now();
  await d.db.transaction(async (tx) => {
    const vs = await tx.all<{ id: string }>("SELECT id FROM app_document_versions WHERE owner_id = ? AND document_id = ?", ownerId, documentId);
    for (const v of vs) await deleteVersionChunks(tx, ownerId, v.id);
    await tx.run(
      "UPDATE app_document_versions SET status = 'purged', summary = NULL, text_blob = NULL, raw_blob = 'purged', content_hash = 'purged:' || id WHERE owner_id = ? AND document_id = ?",
      ownerId,
      documentId,
    );
    await tx.run(
      "UPDATE app_documents SET status = 'purged', current_version_id = NULL, title = CASE WHEN title = source_uri THEN '（已删除）' ELSE title END, source_uri = NULL, tags_json = '[]', error_code = NULL, purged_at = ?, updated_at = ? WHERE owner_id = ? AND id = ?",
      now,
      now,
      ownerId,
      documentId,
    );
    // 采集作业的输入里带着 URL：抹掉
    await tx.run(
      "UPDATE app_jobs SET input_json = json_remove(input_json, '$.url') WHERE owner_id = ? AND kind = 'ingest_url' AND json_extract(input_json, '$.documentId') = ?",
      ownerId,
      documentId,
    );
  });

  // 5. 删 blob：仍被别的版本引用的保留（blob 按内容寻址，可能共享）
  for (const h of blobs) {
    const used = await d.db.get(
      "SELECT 1 AS x FROM app_owners o JOIN app_document_versions v ON v.owner_id = o.id WHERE v.raw_blob = ? OR v.text_blob = ? LIMIT 1", h, h,
    );
    if (!used) d.blobs.delete(h);
  }
}
