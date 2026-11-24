import { AppError, type Clock } from "@durakeep/core";
import { guardDb, migrate, setDeliveryPaused, type SqlDatabase } from "@durakeep/db";
import { BlobStore, readPurgeLog } from "@durakeep/knowledge";
import { copyFileSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { manifestName, readBackupManifest, referencedBlobs, snapshotReferences, stampFromBackup } from "./backup.ts";

function checkpoint(file: string): void {
  const sqlite = new DatabaseSync(file);
  try {
    const row = sqlite.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (row?.busy !== 0) throw new AppError("invalid_request", "无法检查点化 SQLite，请确认没有其他进程占用数据库");
  } finally {
    sqlite.close();
  }
}

/** 调用方持有实例锁。原库保留到所有快照检查与暂停设置都成功后。 */
export async function restoreBackup(dataDir: string, source: string, clock: Clock, open: (path: string) => Promise<SqlDatabase>): Promise<void> {
  const current = join(dataDir, "app.sqlite");
  const manifest = readBackupManifest(join(dirname(source), manifestName(stampFromBackup(source))));
  const purges = readPurgeLog(join(dataDir, "purge-log.jsonl"));
  const temp = mkdtempSync(join(dataDir, ".restore-"));
  const staged = join(temp, "app.sqlite");
  try {
    copyFileSync(source, staged);
    const refs = snapshotReferences(staged, true);
    if (JSON.stringify(referencedBlobs(refs)) !== JSON.stringify([...manifest.blobs].sort())) {
      throw new AppError("invalid_request", "blob 清单与 SQLite 备份引用不一致");
    }
    const blobs = new BlobStore(join(dataDir, "blobs"));
    const surviving = refs.filter((r) => !purges.get(r.owner_id)?.has(r.document_id));
    const missing = referencedBlobs(surviving).filter((h) => !blobs.has(h));
    if (missing.length) throw new AppError("invalid_request", `备份缺少 ${missing.length} 个仍被引用的 blob`);

    const db = guardDb(await open(staged));
    try {
      await migrate(db);
      await setDeliveryPaused(db, true, clock.now());
      // 备份后的外发无法撤销。快照里的待投递记录在当前时间已可能送达。
      await db.run(
        "UPDATE app_outbox SET status = 'unknown', error_code = 'restored_snapshot', updated_at = ? " +
        "WHERE owner_id IN (SELECT id FROM app_owners) AND status IN ('pending', 'dispatching')",
        clock.now(),
      );
      if (manifest.job_id !== null) {
        // 快照中的发起作业还处于 running。该备份已存在，无需在重启时再生成一份。
        await db.run(
          "UPDATE app_jobs SET status = 'succeeded', error_code = NULL, error_message = NULL, updated_at = ? WHERE owner_id IN (SELECT id FROM app_owners) AND id = ? AND kind = 'backup' AND status = 'running'",
          manifest.captured_at, manifest.job_id,
        );
      }
    } finally {
      await db.close();
    }
    checkpoint(staged);

    if (existsSync(current)) {
      checkpoint(current);
      const old = join(temp, "app.sqlite.bak");
      copyFileSync(current, old);
      renameSync(old, `${current}.bak`);
    }
    for (const suffix of ["-wal", "-shm"]) rmSync(current + suffix, { force: true });
    renameSync(staged, current);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
