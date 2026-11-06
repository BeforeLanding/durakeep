import { AppError, canonicalJson, uuidv7, type Json } from "@durakeep/core";
import type { SqlExecutor } from "@durakeep/db";

export type JobKind = "ingest_text" | "ingest_url" | "summarize" | "extract_memory" | "purge_document" | "backup";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type JobRow = {
  id: string;
  ownerId: string;
  kind: JobKind;
  dedupeKey: string;
  input: Json;
  checkpoint: Record<string, Json>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

type Raw = {
  id: string;
  owner_id: string;
  kind: JobKind;
  dedupe_key: string;
  input_json: string;
  checkpoint_json: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: number;
  error_code: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
};

export const JOB_COLS =
  "id, owner_id, kind, dedupe_key, input_json, checkpoint_json, status, attempts, max_attempts, next_attempt_at, error_code, error_message, created_at, updated_at";

export const toJob = (r: Raw): JobRow => ({
  id: r.id,
  ownerId: r.owner_id,
  kind: r.kind,
  dedupeKey: r.dedupe_key,
  input: JSON.parse(r.input_json) as Json,
  checkpoint: JSON.parse(r.checkpoint_json) as Record<string, Json>,
  status: r.status,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  nextAttemptAt: r.next_attempt_at,
  errorCode: r.error_code,
  errorMessage: r.error_message,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * 入队。接受任意 SqlExecutor，所以可以放进调用方的业务事务里（如“创建资料 + 入队作业”原子完成）。
 * (owner_id, dedupe_key) 已存在时返回已有作业（created=false），不会重复入队。
 */
export async function enqueue(
  tx: SqlExecutor,
  now: number,
  input: { ownerId: string; kind: JobKind; dedupeKey: string; input: Json; maxAttempts?: number },
): Promise<{ job: JobRow; created: boolean }> {
  const existing = await tx.get<Raw>(`SELECT ${JOB_COLS} FROM app_jobs WHERE owner_id = ? AND dedupe_key = ?`, input.ownerId, input.dedupeKey);
  if (existing) return { job: toJob(existing), created: false };
  const id = uuidv7(now);
  await tx.run(
    `INSERT INTO app_jobs (id, owner_id, kind, dedupe_key, input_json, status, max_attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    id,
    input.ownerId,
    input.kind,
    input.dedupeKey,
    canonicalJson(input.input),
    input.maxAttempts ?? 3,
    now,
    now,
    now,
  );
  const row = await tx.get<Raw>(`SELECT ${JOB_COLS} FROM app_jobs WHERE id = ?`, id);
  return { job: toJob(row!), created: true };
}

export async function getJob(tx: SqlExecutor, ownerId: string, id: string): Promise<JobRow> {
  const r = await tx.get<Raw>(`SELECT ${JOB_COLS} FROM app_jobs WHERE owner_id = ? AND id = ?`, ownerId, id);
  if (!r) throw new AppError("not_found", "作业不存在");
  return toJob(r);
}

export async function listJobs(
  tx: SqlExecutor,
  ownerId: string,
  opts: { status?: JobStatus; limit?: number } = {},
): Promise<JobRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const rows = opts.status
    ? await tx.all<Raw>(`SELECT ${JOB_COLS} FROM app_jobs WHERE owner_id = ? AND status = ? ORDER BY created_at DESC, id DESC LIMIT ?`, ownerId, opts.status, limit)
    : await tx.all<Raw>(`SELECT ${JOB_COLS} FROM app_jobs WHERE owner_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`, ownerId, limit);
  return rows.map(toJob);
}

/** 06 §7：只对 failed 有效；attempts 清零，重新排队。 */
export async function retryJob(tx: SqlExecutor, now: number, ownerId: string, id: string): Promise<JobRow> {
  const job = await getJob(tx, ownerId, id);
  if (job.status !== "failed") throw new AppError("invalid_request", "只有失败的作业可以重试");
  await tx.run(
    "UPDATE app_jobs SET status = 'queued', attempts = 0, next_attempt_at = ?, error_code = NULL, error_message = NULL, updated_at = ? WHERE owner_id = ? AND id = ?",
    now,
    now,
    ownerId,
    id,
  );
  return getJob(tx, ownerId, id);
}

/** 06 §7：对 queued 和 running 有效。running 的作业由 worker 在下一个检查点放弃。 */
export async function cancelJob(tx: SqlExecutor, now: number, ownerId: string, id: string): Promise<JobRow> {
  const job = await getJob(tx, ownerId, id);
  if (job.status !== "queued" && job.status !== "running") throw new AppError("invalid_request", "只有排队中或运行中的作业可以取消");
  await tx.run("UPDATE app_jobs SET status = 'cancelled', updated_at = ? WHERE owner_id = ? AND id = ?", now, ownerId, id);
  return getJob(tx, ownerId, id);
}
