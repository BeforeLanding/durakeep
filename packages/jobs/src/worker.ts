import { AppError, canonicalJson, type Clock, type Json } from "@durakeep/core";
import type { SqlDatabase } from "@durakeep/db";
import { JOB_COLS, toJob, type JobKind, type JobRow } from "./queue.ts";

/** 处理器抛出它来表达“失败原因 + 是否值得重试”。其他异常按可重试的 internal 处理。 */
export class JobError extends Error {
  readonly code: string;
  readonly userMessage: string;
  readonly retryable: boolean;
  constructor(code: string, userMessage: string, retryable: boolean) {
    super(`${code}: ${userMessage}`);
    this.name = "JobError";
    this.code = code;
    this.userMessage = userMessage;
    this.retryable = retryable;
  }
}

/** 作业被取消时，处理器在检查点抛出（worker 会吞掉它，不改写 cancelled 状态）。 */
export class JobCancelled extends Error {
  constructor() {
    super("job cancelled");
    this.name = "JobCancelled";
  }
}

export interface JobContext {
  readonly job: JobRow;
  /** 已完成阶段的记录；重试时据此跳过（07 §1）。 */
  readonly checkpoint: Record<string, Json>;
  /** 合并写入 checkpoint；同时检查作业是否已被取消（是则抛 JobCancelled）。 */
  save(patch: Record<string, Json>): Promise<void>;
}
export type JobHandler = (ctx: JobContext) => Promise<void>;

export type WorkerOptions = {
  concurrency?: number;
  ownerId?: string;
  /** 在领取模型作业之前刷新用量。配置后模型作业串行，非模型作业仍用其余空位。 */
  refreshModelBudget?: () => Promise<void>;
  /** 第 n 次失败后的退避毫秒数（n 从 1 起）；默认 30 s、2 min。 */
  backoffMs?: (attempt: number) => number;
  log?: (e: { level: "info" | "warn" | "error"; event: string; [k: string]: string | number | boolean | undefined }) => void;
  /** 作业到达终态（succeeded / failed）时回调，用于推送全局流事件。 */
  onFinished?: (job: JobRow) => void | Promise<void>;
};

const defaultBackoff = (attempt: number) => (attempt <= 1 ? 30_000 : 120_000);
const usesModel = (kind: JobKind) => kind === "summarize" || kind === "extract_memory";

/**
 * 进程内作业队列（单进程，不需要租约）。领取 → 执行 → 记录结果；失败按退避重试，达到上限后 failed。
 * 启动时 recover() 把上个进程遗留的 running 改回 queued（03 §5.5）。
 */
export class JobWorker {
  readonly #db: SqlDatabase;
  readonly #clock: Clock;
  readonly #handlers = new Map<JobKind, JobHandler>();
  readonly #opts: Required<Pick<WorkerOptions, "concurrency" | "backoffMs">> & WorkerOptions;
  #running = 0;
  #modelRunning = false;
  #modelJobsPaused = false;
  #started = false;
  #stopped = false;
  #cancelTimer: (() => void) | undefined;
  #pumping = false;
  #pumpCompletion: Promise<void> | undefined;
  /** pump 进行中又收到 wake：结束后必须再跑一轮，否则这次唤醒会丢失（新入队的作业无人领取）。 */
  #again = false;
  #inflight = new Set<Promise<void>>();

  constructor(db: SqlDatabase, clock: Clock, handlers: Partial<Record<JobKind, JobHandler>>, opts: WorkerOptions = {}) {
    this.#db = db;
    this.#clock = clock;
    for (const [k, h] of Object.entries(handlers)) if (h) this.#handlers.set(k as JobKind, h);
    this.#opts = { concurrency: opts.concurrency ?? 2, backoffMs: opts.backoffMs ?? defaultBackoff, ...opts };
  }

  async recover(): Promise<number> {
    const ownerId = this.#opts.ownerId ?? null;
    const rows = await this.#db.all<{ id: string }>("SELECT id FROM app_jobs WHERE owner_id = COALESCE(?, owner_id) AND status = 'running'", ownerId);
    if (rows.length > 0) {
      await this.#db.run("UPDATE app_jobs SET status = 'queued', next_attempt_at = ?, updated_at = ? WHERE owner_id = COALESCE(?, owner_id) AND status = 'running'", this.#clock.now(), this.#clock.now(), ownerId);
      this.#opts.log?.({ level: "info", event: "jobs.recovered", count: rows.length });
    }
    return rows.length;
  }

  start(): void {
    this.#started = true;
    this.#stopped = false;
    this.wake();
  }

  setModelJobsPaused(paused: boolean): void {
    if (this.#modelJobsPaused === paused) return;
    this.#modelJobsPaused = paused;
    this.wake();
  }

  /** 停止领取新作业，并等待正在执行的作业结束。 */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    await this.#pumpCompletion;
    await Promise.allSettled([...this.#inflight]);
  }

  /** 入队或到期后调用：立即尝试领取。 */
  wake(): void {
    if (!this.#started || this.#stopped) return;
    if (this.#pumping) {
      this.#again = true;
      return;
    }
    this.#pumpCompletion = this.#pump();
  }

  /** 测试用：等到没有可立即执行的作业、也没有正在执行的作业。 */
  async idle(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const next = await this.#nextAttempt(this.#eligibleKinds());
      if (this.#running === 0 && !this.#pumping && (next === null || next > this.#clock.now())) return;
      if (Date.now() > deadline) throw new Error("JobWorker.idle 超时");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async #pump(): Promise<void> {
    this.#pumping = true;
    try {
      do {
        this.#again = false;
        await this.#drain();
      } while (this.#again && !this.#stopped);
    } finally {
      this.#pumping = false;
    }
  }

  async #drain(): Promise<void> {
    while (!this.#stopped && this.#running < this.#opts.concurrency) {
      if (this.#opts.refreshModelBudget) {
        const nextModel = await this.#nextAttempt(this.#eligibleKinds().filter(usesModel));
        if (nextModel !== null && nextModel <= this.#clock.now()) await this.#opts.refreshModelBudget();
      }
      if (this.#stopped) break;
      const job = await this.#claim();
      if (!job) break;
      this.#running++;
      const trackedModel = this.#opts.refreshModelBudget !== undefined && usesModel(job.kind);
      if (trackedModel) this.#modelRunning = true;
      const p = this.#run(job).finally(() => {
        this.#running--;
        if (trackedModel) this.#modelRunning = false;
        this.#inflight.delete(p);
        this.wake();
      });
      this.#inflight.add(p);
    }
    await this.#arm();
  }

  /** 为最早的未到期作业设置一个定时器。 */
  async #arm(): Promise<void> {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    if (this.#stopped || this.#running >= this.#opts.concurrency) return;
    const next = await this.#nextAttempt(this.#eligibleKinds());
    if (this.#stopped || next === null) return;
    const wait = Math.max(0, next - this.#clock.now());
    this.#cancelTimer = this.#clock.setTimer(() => this.wake(), wait);
  }

  #eligibleKinds(): JobKind[] {
    const kinds = [...this.#handlers.keys()];
    return this.#modelJobsPaused || this.#modelRunning ? kinds.filter((kind) => !usesModel(kind)) : kinds;
  }

  async #nextAttempt(kinds: JobKind[]): Promise<number | null> {
    if (kinds.length === 0) return null;
    const row = await this.#db.get<{ t: number | null }>(
      `SELECT MIN(next_attempt_at) AS t FROM app_jobs
        WHERE owner_id = COALESCE(?, owner_id) AND status = 'queued' AND kind IN (${kinds.map(() => "?").join(",")})`,
      this.#opts.ownerId ?? null, ...kinds,
    );
    return row?.t ?? null;
  }

  async #claim(): Promise<JobRow | undefined> {
    const now = this.#clock.now();
    return this.#db.transaction(async (tx) => {
      const kinds = this.#eligibleKinds();
      if (kinds.length === 0) return undefined;
      const row = await tx.get<Parameters<typeof toJob>[0]>(
        `SELECT ${JOB_COLS} FROM app_jobs
          WHERE owner_id = COALESCE(?, owner_id) AND status = 'queued' AND next_attempt_at <= ? AND kind IN (${kinds.map(() => "?").join(",")})
          ORDER BY next_attempt_at, created_at LIMIT 1`,
        this.#opts.ownerId ?? null, now,
        ...kinds,
      );
      if (!row) return undefined;
      await tx.run("UPDATE app_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE owner_id = ? AND id = ?", now, row.owner_id, row.id);
      return { ...toJob(row), status: "running" as const, attempts: row.attempts + 1 };
    });
  }

  async #run(job: JobRow): Promise<void> {
    const handler = this.#handlers.get(job.kind)!;
    const checkpoint: Record<string, Json> = { ...job.checkpoint };
    const ctx: JobContext = {
      job,
      checkpoint,
      save: async (patch) => {
        Object.assign(checkpoint, patch);
        const r = await this.#db.get<{ status: string }>("SELECT status FROM app_jobs WHERE owner_id = ? AND id = ?", job.ownerId, job.id);
        if (r?.status === "cancelled") throw new JobCancelled();
        await this.#db.run("UPDATE app_jobs SET checkpoint_json = ?, updated_at = ? WHERE owner_id = ? AND id = ?", canonicalJson(checkpoint), this.#clock.now(), job.ownerId, job.id);
      },
    };
    try {
      await handler(ctx);
      const done = await this.#db.get<{ status: string }>("SELECT status FROM app_jobs WHERE owner_id = ? AND id = ?", job.ownerId, job.id);
      if (done?.status === "cancelled") return;
      await this.#db.run("UPDATE app_jobs SET status = 'succeeded', error_code = NULL, error_message = NULL, updated_at = ? WHERE owner_id = ? AND id = ?", this.#clock.now(), job.ownerId, job.id);
      this.#opts.log?.({ level: "info", event: "job.succeeded", job_id: job.id, kind: job.kind });
      await this.#finished(job);
    } catch (e) {
      if (e instanceof JobCancelled) return;
      const code = e instanceof JobError ? e.code : e instanceof AppError ? e.code : "internal";
      const message = e instanceof JobError ? e.userMessage : e instanceof AppError ? e.userMessage : "处理时出现内部错误";
      const retryable = e instanceof JobError ? e.retryable : e instanceof AppError ? false : true;
      const now = this.#clock.now();
      if (retryable && job.attempts < job.maxAttempts) {
        const at = now + this.#opts.backoffMs(job.attempts);
        await this.#db.run(
          "UPDATE app_jobs SET status = 'queued', next_attempt_at = ?, error_code = ?, error_message = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND status = 'running'",
          at, code, message, now, job.ownerId, job.id,
        );
        this.#opts.log?.({ level: "warn", event: "job.retry", job_id: job.id, kind: job.kind, attempt: job.attempts, code });
      } else {
        await this.#db.run(
          "UPDATE app_jobs SET status = 'failed', error_code = ?, error_message = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND status = 'running'",
          code, message, now, job.ownerId, job.id,
        );
        this.#opts.log?.({ level: "warn", event: "job.failed", job_id: job.id, kind: job.kind, code });
        await this.#finished(job);
      }
    }
  }

  async #finished(job: JobRow): Promise<void> {
    if (!this.#opts.onFinished) return;
    const r = await this.#db.get<Parameters<typeof toJob>[0]>(`SELECT ${JOB_COLS} FROM app_jobs WHERE owner_id = ? AND id = ?`, job.ownerId, job.id);
    if (r) {
      try {
        await this.#opts.onFinished(toJob(r));
      } catch {
        /* 回调出错不影响作业状态 */
      }
    }
  }
}
