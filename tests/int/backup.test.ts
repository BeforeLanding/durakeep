import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { BackupService, manifestName, stampFromBackup, startDailyBackup, type BackupManifest } from "../../apps/server/src/backup.ts";
import { restoreBackup } from "../../apps/server/src/restore.ts";
import { FakeClock } from "../../packages/core/src/index.ts";
import { backupInto, deliveryPaused, guardDb, migrate, type SqlDatabase } from "../../packages/db/src/index.ts";
import { JobWorker } from "../../packages/jobs/src/index.ts";
import { BlobStore } from "../../packages/knowledge/src/index.ts";
import { openAppDatabase } from "../../packages/runtime-pi/src/index.ts";

const START = Date.UTC(2026, 10, 6, 3, 16, 59);
const DAY = 86_400_000;
const OWNER = "backup-owner";
let dir: string;
let db: SqlDatabase;
let clock: FakeClock;
let blobs: BlobStore;
let service: BackupService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "durakeep-backup-"));
  db = guardDb(await openAppDatabase(join(dir, "app.sqlite")));
  await migrate(db);
  clock = new FakeClock(START);
  blobs = new BlobStore(join(dir, "blobs"));
  service = new BackupService(db, clock, dir, (path) => backupInto(db, path));
  await db.run("INSERT INTO app_owners (id, display_name, created_at) VALUES (?, '备份测试', ?)", OWNER, START);
});

afterEach(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function addDocument(id: string, content: string) {
  const hash = blobs.put(content);
  await db.run("INSERT INTO app_documents (id, owner_id, source_type, title, status, created_at, updated_at) VALUES (?, ?, 'text', ?, 'ready', ?, ?)", id, OWNER, id, START, START);
  await db.run(
    `INSERT INTO app_document_versions (id, document_id, owner_id, content_hash, raw_blob, text_blob, parser_version, status, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, 'test', 'ready', ?)`, `version-${id}`, id, OWNER, hash, hash, hash, START,
  );
  return hash;
}

const manifestPath = (file: string) => join(dir, "backups", manifestName(stampFromBackup(file)));

test("清单以 SQLite 快照为准，默认仅保留最后七对并保留其他文件", async () => {
  const original = await addDocument("before", "snapshot content");
  const backup = new BackupService(db, clock, dir, async (path) => {
    await backupInto(db, path);
    await addDocument("after", "later write");
  });
  const first = await backup.create();
  expect(JSON.parse(readFileSync(manifestPath(first), "utf8"))).toEqual({
    version: 1, captured_at: START, job_id: null, blobs: [original],
  });
  const backups = join(dir, "backups");
  for (const unrelated of ["notes.sqlite", "app-not-a-backup.sqlite", "notes.json", "keep.partial"]) {
    writeFileSync(join(backups, unrelated), "leave in place");
  }
  const newer: string[] = [];
  for (let i = 0; i < 7; i++) {
    clock.advance(DAY);
    newer.push(await service.create());
  }
  expect(existsSync(first)).toBe(false);
  expect(existsSync(manifestPath(first))).toBe(false);
  for (const file of newer) {
    expect(existsSync(file)).toBe(true);
    expect(existsSync(manifestPath(file))).toBe(true);
  }
  expect(readdirSync(backups)).toHaveLength(18);
  for (const unrelated of ["notes.sqlite", "app-not-a-backup.sqlite", "notes.json", "keep.partial"]) {
    expect(readFileSync(join(backups, unrelated), "utf8")).toBe("leave in place");
  }
  await db.run("INSERT INTO app_settings (key, value_json, updated_at) VALUES ('backup_keep', '2', ?)", clock.now());
  const next = await service.create();
  expect(next).not.toBe(newer.at(-1));
  expect(readdirSync(backups).filter((name) => /^app-\d/.test(name))).toEqual([basename(newer.at(-1)!), basename(next)].sort());
});

test("定时备份按 UTC 日期去重，重启补当天，翌日再次执行", async () => {
  const worker = new JobWorker(db, clock, { backup: service.handler });
  const onError = (e: unknown) => { throw e; };
  worker.start();
  let stop = startDailyBackup(clock, service, () => worker.wake(), onError);
  const jobs = () => db.all<{ status: string; dedupe_key: string }>(
    "SELECT status, dedupe_key FROM app_jobs WHERE owner_id = ? AND kind = 'backup' ORDER BY dedupe_key", OWNER,
  );
  try {
    await worker.idle();
    expect(await jobs()).toEqual([]);
    clock.advance(1_000);
    await expect.poll(jobs).toEqual([{ status: "succeeded", dedupe_key: "backup:daily:2026-11-06" }]);
    await stop();
    stop = startDailyBackup(clock, service, () => worker.wake(), onError);
    await worker.idle();
    expect(await jobs()).toHaveLength(1);
    clock.advance(DAY);
    await expect.poll(jobs).toEqual([
      { status: "succeeded", dedupe_key: "backup:daily:2026-11-06" },
      { status: "succeeded", dedupe_key: "backup:daily:2026-11-07" },
    ]);
  } finally {
    await stop();
    await worker.stop();
  }
});

test("恢复在原库替换前拒绝损坏快照、错误清单及仍被引用的缺失 blob", async () => {
  const shared = await addDocument("deleted", "content shared across documents");
  await addDocument("retained", "content shared across documents");
  const file = await service.create();
  const manifest = readFileSync(manifestPath(file), "utf8");
  const sqlite = readFileSync(file);
  const restore = () => restoreBackup(dir, file, clock, openAppDatabase);
  writeFileSync(file, "corrupt");
  await expect(restore()).rejects.toThrow();
  writeFileSync(file, sqlite);
  writeFileSync(manifestPath(file), "{}");
  await expect(restore()).rejects.toThrow("有效的 blob 清单");
  writeFileSync(manifestPath(file), JSON.stringify({ ...JSON.parse(manifest) as BackupManifest, blobs: [] }));
  await expect(restore()).rejects.toThrow("引用不一致");
  writeFileSync(manifestPath(file), manifest);
  writeFileSync(join(dir, "purge-log.jsonl"), JSON.stringify({ owner_id: OWNER, document_id: "deleted" }) + "\n");
  blobs.delete(shared);
  await expect(restore()).rejects.toThrow("缺少 1 个");
  expect(await deliveryPaused(db)).toBe(false);
  expect(existsSync(join(dir, "app.sqlite.bak"))).toBe(false);
});
