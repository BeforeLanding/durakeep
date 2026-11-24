import { AppError, uuidv7, type Clock, type RuntimePort } from "@durakeep/core";
import type { SqlDatabase } from "@durakeep/db";
import { enqueue, type JobHandler } from "@durakeep/jobs";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readBackupKeep } from "./settings.ts";

const BACKUP_STAMP = "\\d{8}T\\d{9}Z";
const BACKUP_NAME = new RegExp(`^app-(${BACKUP_STAMP})\\.sqlite$`);
const STAGING_NAME = new RegExp(`^(?:app-${BACKUP_STAMP}\\.sqlite\\.partial(?:\\.partial)?|blobs-manifest-${BACKUP_STAMP}\\.json\\.partial)$`);
const DAY_MS = 86_400_000;
const DAILY_OFFSET_MS = (3 * 60 + 17) * 60_000;

export function backupStamp(at: number): string {
  return new Date(at).toISOString().replace(/[-:.]/g, "");
}

export function manifestName(stamp: string): string {
  return `blobs-manifest-${stamp}.json`;
}

export function stampFromBackup(path: string): string {
  const stamp = BACKUP_NAME.exec(basename(path))?.[1];
  if (!stamp) throw new AppError("invalid_request", "备份文件名应为 app-<UTC 时间戳>.sqlite");
  return stamp;
}

export type BackupManifest = { version: 1; captured_at: number; job_id: string | null; blobs: string[] };
export type BlobReference = { owner_id: string; document_id: string; raw_blob: string; text_blob: string | null };

export function readBackupManifest(path: string): BackupManifest {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<BackupManifest> | null;
    if (data?.version === 1 && Number.isSafeInteger(data.captured_at) &&
        (data.job_id === null || typeof data.job_id === "string") &&
        Array.isArray(data.blobs) && data.blobs.every((h) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h))) {
      return data as BackupManifest;
    }
  } catch {
    // 恢复需要 SQLite 和清单成对提供。
  }
  throw new AppError("invalid_request", "备份缺少有效的 blob 清单");
}

/** 从快照本身取引用，避免 VACUUM 与读取在线数据库之间的写入改变清单。 */
export function snapshotReferences(file: string, checkIntegrity = false): BlobReference[] {
  const snapshot = new DatabaseSync(file, { readOnly: true });
  try {
    if (checkIntegrity) {
      const rows = snapshot.prepare("PRAGMA integrity_check").all();
      if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
        throw new AppError("invalid_request", "SQLite 备份未通过 integrity_check");
      }
    }
    return snapshot.prepare(
      `SELECT v.owner_id, v.document_id, v.raw_blob, v.text_blob
         FROM app_owners o JOIN app_document_versions v ON v.owner_id = o.id
        WHERE v.status != 'purged'`,
    ).all() as BlobReference[];
  } finally {
    snapshot.close();
  }
}

export function referencedBlobs(refs: BlobReference[]): string[] {
  return [...new Set(refs.flatMap(({ raw_blob, text_blob }) => text_blob === null ? [raw_blob] : [raw_blob, text_blob]))].sort();
}

export class BackupService {
  readonly #db: SqlDatabase;
  readonly #clock: Clock;
  readonly #dir: string;
  readonly #backupInto: RuntimePort["backupInto"];
  #chain: Promise<unknown> = Promise.resolve();

  constructor(db: SqlDatabase, clock: Clock, dataDir: string, backupInto: RuntimePort["backupInto"]) {
    this.#db = db;
    this.#clock = clock;
    this.#dir = join(dataDir, "backups");
    this.#backupInto = backupInto;
  }

  async enqueue(ownerId: string, requestId?: string): Promise<{ jobId: string; created: boolean }> {
    const now = this.#clock.now();
    const { job, created } = await this.#db.transaction((tx) => enqueue(tx, now, {
      ownerId, kind: "backup", input: {}, dedupeKey: `backup:manual:${requestId ?? uuidv7(now)}`,
    }));
    return { jobId: job.id, created };
  }

  async enqueueDaily(now: number): Promise<void> {
    const day = new Date(now).toISOString().slice(0, 10);
    const owner = await this.#db.get<{ id: string }>("SELECT id FROM app_owners LIMIT 1");
    if (!owner) return;
    await this.#db.transaction((tx) => enqueue(tx, now, {
      ownerId: owner.id, kind: "backup", input: {}, dedupeKey: `backup:daily:${day}`,
    }));
  }

  handler: JobHandler = async (ctx) => {
    await this.#serialize(async () => {
      await ctx.save({}); // 排队等待其他备份期间可能已取消
      await this.#create(ctx.job.id);
    });
  };

  create(): Promise<string> {
    return this.#serialize(() => this.#create(null));
  }

  #serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(action);
    this.#chain = result.catch(() => {});
    return result;
  }

  latestAt(): number | null {
    try {
      return this.#pairs()[0]?.capturedAt ?? null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
  }

  #pairs(): { file: string; manifest: string; jobId: string | null; capturedAt: number }[] {
    if (!existsSync(this.#dir)) return [];
    const files = readdirSync(this.#dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort().reverse();
    const names = new Set(files);
    return files.flatMap((name) => {
      const stamp = BACKUP_NAME.exec(name)?.[1];
      if (!stamp || !names.has(manifestName(stamp))) return [];
      const manifest = join(this.#dir, manifestName(stamp));
      try {
        const data = readBackupManifest(manifest);
        return [{ file: join(this.#dir, name), manifest, jobId: data.job_id, capturedAt: data.captured_at }];
      } catch {
        return [];
      }
    });
  }

  async #create(jobId: string | null): Promise<string> {
    mkdirSync(this.#dir, { recursive: true });
    for (const entry of readdirSync(this.#dir, { withFileTypes: true })) {
      if (entry.isFile() && STAGING_NAME.test(entry.name)) rmSync(join(this.#dir, entry.name), { force: true });
    }
    const retention = await readBackupKeep(this.#db);

    // 恢复上次进程在发布后、记录作业完成前中断的情况。
    const previous = jobId === null ? undefined : this.#pairs().find((pair) => pair.jobId === jobId);
    if (previous) {
      this.#rotate(retention);
      return previous.file;
    }

    const capturedAt = this.#clock.now();
    let stampAt = capturedAt;
    const targets = (at: number) => ({
      file: join(this.#dir, `app-${backupStamp(at)}.sqlite`),
      manifest: join(this.#dir, manifestName(backupStamp(at))),
    });
    let { file, manifest } = targets(stampAt);
    while (existsSync(file) || existsSync(manifest)) {
      ({ file, manifest } = targets(++stampAt));
    }
    const staged = `${file}.partial`;
    try {
      await this.#backupInto(staged);
      const data: BackupManifest = { version: 1, captured_at: capturedAt, job_id: jobId, blobs: referencedBlobs(snapshotReferences(staged)) };
      writeFileSync(`${manifest}.partial`, JSON.stringify(data, null, 2) + "\n", { flush: true });
      renameSync(`${manifest}.partial`, manifest);
      renameSync(staged, file); // .sqlite 出现时，清单已经到位
    } finally {
      rmSync(staged, { force: true });
      rmSync(`${staged}.partial`, { force: true });
      rmSync(`${manifest}.partial`, { force: true });
      if (!existsSync(file)) rmSync(manifest, { force: true });
    }
    this.#rotate(retention);
    return file;
  }

  #rotate(keep: number): void {
    for (const { file, manifest } of this.#pairs().slice(keep)) {
      rmSync(file);
      rmSync(manifest);
    }
  }
}

/** 每个 UTC 日在 03:17 入队一次。启动时补当天已错过的时点。 */
export function startDailyBackup(clock: Clock, backup: BackupService, wake: () => void, onError: (error: unknown) => void): () => Promise<void> {
  let stopped = false;
  let cancel: (() => void) | undefined;
  let running: Promise<void>;
  function schedule() {
    running = tick();
  }
  async function tick() {
    const now = clock.now();
    const due = Math.floor(now / DAY_MS) * DAY_MS + DAILY_OFFSET_MS;
    let next = due;
    try {
      if (now >= due) {
        await backup.enqueueDaily(now);
        wake();
        next += DAY_MS;
      }
    } catch (e) {
      onError(e);
      next = now + 60_000;
    }
    if (!stopped) cancel = clock.setTimer(schedule, Math.max(0, next - clock.now()));
  }
  schedule();
  return async () => {
    stopped = true;
    cancel?.();
    await running;
  };
}
