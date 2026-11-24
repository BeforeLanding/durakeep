import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createApp } from "../../apps/server/src/app.ts";
import { EventStore } from "../../apps/server/src/events.ts";
import { systemClock } from "../../packages/core/src/index.ts";
import { guardDb, migrate } from "../../packages/db/src/index.ts";
import { openAppDatabase, PiRuntime, presentPiReport, startPi } from "../../packages/runtime-pi/src/index.ts";
import { fauxAssistantMessage, fauxProvider } from "../../packages/runtime-pi/src/testing/faux.ts";
import { UPGRADE_SECRET, upgradeFixture, upgradeModel } from "../../packages/runtime-pi/src/testing/upgrade-fixture.ts";
import { repoRoot, runChild } from "../support/driver.ts";

const script = join(repoRoot, "packages/runtime-pi/src/testing/child-upgrade.ts");
const origin = "http://127.0.0.1:4777";

test.each(Array.from({ length: 20 }, (_, i) => ({ round: i + 1, restartLimit: i % 2 === 1 })))(
  "R11 / FR-TASK-02 第 $round 轮：旧库副本迁移、阻塞受报，连续崩溃=$restartLimit",
  async ({ restartLimit }) => {
  const base = mkdtempSync(join(tmpdir(), "durakeep-upgrade-"));
  const oldDir = join(base, "old");
  const copyDir = join(base, "candidate");
  mkdirSync(oldDir);
  try {
    const crash = await runChild(script, { DATA_DIR: oldDir, SCENARIO: "first", FAULT_POINT: "tool.in_execute" });
    expect(crash.code === 1 || crash.signal === "SIGKILL", crash.stderr).toBe(true);
    const fixture = JSON.parse(readFileSync(join(oldDir, "fixture.json"), "utf8")) as { taskId: string; submissionId: string };
    if (restartLimit) {
      const again = await runChild(script, { DATA_DIR: oldDir, SCENARIO: "retry", FAULT_POINT: "tool.in_execute" });
      expect(again.code === 1 || again.signal === "SIGKILL", again.stderr).toBe(true);
    }
    // 旧进程已停止；复制数据库和仍存在的 WAL，SQLite 在副本自行重建 SHM。
    mkdirSync(copyDir);
    for (const name of ["app.sqlite", "app.sqlite-wal"]) {
      if (existsSync(join(oldDir, name))) cpSync(join(oldDir, name), join(copyDir, name));
    }
    const raw = await openAppDatabase(join(copyDir, "app.sqlite"));
    const db = guardDb(raw);
    expect(await migrate(db)).toBe(1);
    const events = new EventStore(db, systemClock);
    const { auth, app } = createApp({ db, clock: systemClock, events, origin });
    const owner = await auth.initOwner({ password: "fixture password", timezone: "UTC" });
    const { token } = await auth.login("fixture password");
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("旧 run 已完成")]);
    const pending: Promise<void>[] = [];
    const pi = await startPi({
      mode: "test", db: raw, faux, extensions: [upgradeFixture(2).extension],
      now: () => Date.now() + 1_200_000,
      settings: { restartLimit: 2 },
      onReport: (r) => pending.push(events.recordPi(owner.id, presentPiReport(r))),
    });
    const runtime = new PiRuntime(pi, { model: upgradeModel });
    try {
      runtime.resume();
      expect(await runtime.waitSubmission(fixture.submissionId, AbortSignal.timeout(10_000))).toEqual({ status: "done", answerText: "旧 run 已完成" });
      const get = async () => {
        await Promise.all(pending);
        const response = await app.request("/v1/events", { headers: { Cookie: `sid=${token}` } });
        expect(response.status).toBe(200);
        return await response.json() as { items: { kind: string; message: string; ref: Record<string, string> }[] };
      };
      await expect.poll(async () => (await get()).items, { timeout: 10_000 }).toContainEqual(expect.objectContaining({
        kind: "pi.task_blocked", message: "migration_failed", ref: expect.objectContaining({ task_id: fixture.taskId, report_kind: "migration_failed" }),
      }));
      const final = await get();
      expect(final.items.some((e) => e.message === "restart_limit")).toBe(restartLimit);
      expect(JSON.stringify(final)).not.toContain(UPGRADE_SECRET);
      expect(faux.state.callCount).toBe(1);
    } finally {
      await runtime.close();
    }
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
