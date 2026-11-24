import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import type { BackupManifest } from "../../apps/server/src/backup.ts";
import { systemClock } from "../../packages/core/src/index.ts";
import { guardDb } from "../../packages/db/src/index.ts";
import { BlobStore, KnowledgeRetrieval } from "../../packages/knowledge/src/index.ts";
import { MemoryService } from "../../packages/memory/src/index.ts";
import { ReminderService } from "../../packages/reminders/src/index.ts";
import { openAppDatabase } from "../../packages/runtime-pi/src/index.ts";
import { cli, freePort, get, initOwner, loginCookie, post, startServer, type Server } from "../support/server.ts";
import { repoRoot } from "../support/driver.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const REPEAT = Number(process.env.REPEAT ?? 20);
const exec = promisify(execFile);
const KEPT = "retainedevidence";
const PURGED = "purgedsentinel";
const MESSAGE = "备份前对话内容";

const runCli = (dir: string, ...args: string[]) => exec(process.execPath, [cli, ...args], {
  cwd: repoRoot, env: { ...process.env, APP_MODE: "test", DATA_DIR: dir }, timeout: 20_000,
});

async function body<T>(response: Promise<Response>, status = 200): Promise<T> {
  const r = await response;
  if (r.status !== status) throw new Error(`HTTP ${r.status}，期望 ${status}：${await r.text()}`);
  return await r.json() as T;
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const until = Date.now() + 15_000;
  for (;;) {
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= until) throw new Error(`等待超时：${JSON.stringify(value)}`);
    await delay(30);
  }
}

test(`R12 × ${REPEAT}：在线备份 → 彻底删除及后续写入 → 离线恢复 → 验证暂停、关联及删除重放`, async () => {
  const measures: { cli_ms: number; ready_ms: number; loss_window_ms: number }[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const dir = mkdtempSync(join(tmpdir(), "durakeep-r12-"));
    let server: Server | undefined;
    try {
      await initOwner(dir);
      const port = await freePort();
      server = await startServer(dir, port);
      const base = server.base;
      let cookie = await loginCookie(base);
      const owner = await body<{ owner_id: string }>(get(base, "/v1/me", cookie));
      const { owner_id: ownerId } = owner;
      const fetchJob = (id: string) => body<{ status: string }>(get(base, `/v1/jobs/${id}`, cookie));
      async function createDoc(text: string) {
        const r = await body<{ document_id: string; job_id: string }>(
          post(base, "/v1/documents", cookie, { client_request_id: crypto.randomUUID(), type: "text", text }), 202,
        );
        await waitFor(() => fetchJob(r.job_id), (j) => j.status === "succeeded");
        return r.document_id;
      }
      const kept = await createDoc(KEPT);
      const purged = await createDoc(PURGED);
      const { id: conversationId } = await body<{ id: string }>(post(base, "/v1/conversations", cookie, {}), 201);
      const entriesPath = `/v1/conversations/${conversationId}/entries`;
      await body(post(base, `/v1/conversations/${conversationId}/messages`, cookie, { client_request_id: crypto.randomUUID(), text: MESSAGE }), 202);
      await waitFor(() => body(get(base, entriesPath, cookie)), (page) => JSON.stringify(page).includes("这是演示模式的回复"));
      await server.stop();
      server = undefined;

      // 通过业务服务建立记忆来源及会话提醒关联；当前 HTTP 创建接口只支持手动来源及资料关联。
      const db = guardDb(await openAppDatabase(join(dir, "app.sqlite")));
      let keptVersion: string;
      let purgedChunks: number[];
      let reminderId: string;
      let memoryId: string;
      try {
        keptVersion = (await db.get<{ id: string }>("SELECT id FROM app_document_versions WHERE owner_id = ? AND document_id = ?", ownerId, kept))!.id;
        purgedChunks = (await db.all<{ id: number }>("SELECT id FROM app_chunks WHERE owner_id = ? AND document_id = ?", ownerId, purged)).map((r) => r.id);
        expect(purgedChunks.length).toBeGreaterThan(0);
        memoryId = (await new MemoryService(db, systemClock).remember(ownerId, {
          kind: "project_context", key: "r12.reference", value: "备份前记忆", changedBy: "user",
          source: { kind: "document", conversation_id: conversationId, version_id: keptVersion },
        })).memoryId;
        reminderId = (await new ReminderService(db, systemClock).create(ownerId, {
          text: "备份前提醒", timezone: "UTC", local_datetime: new Date(Date.now() + 86_400_000).toISOString().slice(0, 16), document_id: kept, conversationId,
        })).id;
      } finally {
        await db.close();
      }

      server = await startServer(dir, port);
      const request = { client_request_id: crypto.randomUUID() };
      const { job_id: backupJob } = await body<{ job_id: string }>(post(base, "/v1/admin/backup", cookie, request), 202);
      await waitFor(() => fetchJob(backupJob), (j) => j.status === "succeeded");
      expect(await body(post(base, "/v1/admin/backup", cookie, request))).toEqual({ job_id: backupJob });
      const backups = join(dir, "backups");
      const name = readdirSync(backups).find((file) => {
        if (!file.startsWith("blobs-manifest-") || !file.endsWith(".json")) return false;
        const manifest = JSON.parse(readFileSync(join(backups, file), "utf8")) as BackupManifest;
        return manifest.job_id === backupJob;
      })!;
      const manifest = JSON.parse(readFileSync(join(backups, name), "utf8")) as BackupManifest;
      const snapshot = join(backups, name.replace("blobs-manifest-", "app-").replace(/\.json$/, ".sqlite"));
      if (i === 0) {
        await expect(runCli(dir, "backup")).rejects.toMatchObject({ stderr: expect.stringContaining("/v1/admin/backup") });
        await expect(runCli(dir, "restore", snapshot)).rejects.toMatchObject({ stderr: expect.stringContaining("请先停止服务") });
      }
      const purge = await body<{ job_id: string }>(fetch(`${base}/v1/documents/${purged}`, {
        method: "DELETE", headers: { Cookie: cookie, Origin: base },
      }), 202);
      await waitFor(() => fetchJob(purge.job_id), (j) => j.status === "succeeded");
      expect(readFileSync(join(dir, "purge-log.jsonl"), "utf8")).toContain(purged);
      expect(manifest.blobs.some((hash) => !new BlobStore(join(dir, "blobs")).has(hash))).toBe(true);
      const { id: later } = await body<{ id: string }>(post(base, "/v1/memories", cookie, {
        client_request_id: crypto.randomUUID(), kind: "project_context", key: "r12.later", value: "备份后的变更",
      }), 201);
      const stoppedAt = Date.now();
      server.proc.kill("SIGKILL"); // 跨平台遗留 WAL 与实例锁
      await server.exited;
      server = undefined;

      const restoreStarted = Date.now();
      await runCli(dir, "restore", snapshot);
      const cliMs = Date.now() - restoreStarted;
      expect(existsSync(join(dir, "app.sqlite.bak"))).toBe(true);
      server = await startServer(dir, port);
      const readyMs = Date.now() - restoreStarted;
      cookie = await loginCookie(base);
      expect(await body(get(base, "/v1/admin/health", cookie))).toEqual({ delivery_paused: true });
      const exportedDir = join(dir, "exports");
      expect(await body(get(base, "/v1/memories", cookie))).toMatchObject({
        items: [{ id: memoryId, source: { conversation_id: conversationId, version_id: keptVersion } }],
      });
      expect(await body(get(base, "/v1/reminders", cookie))).toMatchObject({ items: [{ id: reminderId, document_id: kept, status: "active" }] });
      expect(JSON.stringify(await body(get(base, entriesPath, cookie)))).toContain(MESSAGE);
      const text = await get(base, `/v1/documents/${kept}/versions/${keptVersion}/text`, cookie);
      expect(text.status).toBe(200);
      expect((await text.text()).trim()).toBe(KEPT);
      expect((await get(base, `/v1/documents/${purged}`, cookie)).status).toBe(404);
      for (const id of purgedChunks) expect((await get(base, `/v1/chunks/${id}`, cookie)).status).toBe(404);
      await server.stop();
      server = undefined;

      const restored = guardDb(await openAppDatabase(join(dir, "app.sqlite")));
      try {
        const retrieval = new KnowledgeRetrieval(restored);
        expect((await retrieval.search(ownerId, { query: KEPT })).text).toContain(KEPT);
        expect((await retrieval.search(ownerId, { query: PURGED })).text).not.toContain(PURGED);
        for (const id of purgedChunks) {
          expect(await restored.get("SELECT rowid FROM app_chunks_fts WHERE rowid = ?", id)).toBeUndefined();
          expect(await restored.get("SELECT rowid FROM app_chunks_tri WHERE rowid = ?", id)).toBeUndefined();
        }
        expect(await restored.get("SELECT summary, text_blob, status FROM app_document_versions WHERE owner_id = ? AND document_id = ?", ownerId, purged)).toEqual({
          summary: null, text_blob: null, status: "purged",
        });
        expect(await restored.get("SELECT conversation_id FROM app_schedules WHERE owner_id = ? AND id = ?", ownerId, reminderId)).toEqual({ conversation_id: conversationId });
      } finally {
        await restored.close();
      }
      if (i === 0) {
        await runCli(dir, "export", exportedDir);
        const zip = readFileSync(join(exportedDir, readdirSync(exportedDir)[0]!));
        expect(zip.includes(Buffer.from(KEPT))).toBe(true);
        expect(zip.includes(Buffer.from(PURGED))).toBe(false);
        const original = await openAppDatabase(join(dir, "app.sqlite.bak"));
        try {
          expect(await original.get("SELECT id FROM app_memories WHERE owner_id = ? AND id = ?", ownerId, later)).toEqual({ id: later });
        } finally {
          await original.close();
        }
        await runCli(dir, "backup");
      }
      measures.push({ cli_ms: cliMs, ready_ms: readyMs, loss_window_ms: stoppedAt - manifest.captured_at });
    } catch (e) {
      throw new Error(`R12 第 ${i + 1} 轮失败\n${server?.out() ?? ""}`, { cause: e });
    } finally {
      await server?.stop();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
  console.log("R12 timings (ms):", JSON.stringify(measures));
}, 900_000);
