// R14 × N：后台会话在 background.after_answer 被杀（模型已回答、业务未写回）→ 恢复后摘要写回，faux 的 callCount 不增加。
// 另有 background.after_create：会话已创建、ID 未写入作业 → 重跑创建新会话，只留下一个无害的孤儿（ADR-10 后果）。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { repoRoot } from "../support/driver.ts";

const REPEAT = Number(process.env.REPEAT ?? 10);
const child = join(repoRoot, "tests/support/bg-child.ts");

function run(dir: string, scenario: string, fault?: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [child], {
      env: { ...process.env, APP_MODE: "test", DATA_DIR: dir, SCENARIO: scenario, ...(fault ? { FAULT_POINT: fault } : {}) },
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout!.on("data", (d) => (out += d));
    p.stderr!.on("data", (d) => (out += d));
    p.once("exit", (code) => resolve({ code, out }));
  });
}
const result = (out: string) => JSON.parse(/RESULT (.*)/.exec(out)?.[1] ?? "null") as { summary: string | null; callCount: number; jobs: { status: string; attempts: number; pi_conversation_id: string }[] } | null;

test(`R14 × ${REPEAT}：background.after_answer 被杀 → 恢复后摘要写回、callCount 为 0、同一个后台会话`, async () => {
  const failures: string[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const dir = mkdtempSync(join(tmpdir(), "durakeep-r14-"));
    try {
      const a = await run(dir, "first", "background.after_answer");
      if (a.code === 0 || result(a.out)) failures.push(`#${i} 第一次没有被杀：${a.code} ${a.out.slice(-200)}`);
      const b = await run(dir, "second");
      const r = result(b.out);
      const ok = r && r.summary === "- 第一次的要点" && r.callCount === 0 && r.jobs.length === 1 && r.jobs[0]!.status === "succeeded" && /^\d+$/.test(r.jobs[0]!.pi_conversation_id);
      if (!ok) failures.push(`#${i} 恢复后 ${b.code} ${JSON.stringify(r)} ${r ? "" : b.out.slice(-300)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
  expect(failures).toEqual([]);
}, 600_000);

test("background.after_create：会话已创建但 ID 未写入 → 恢复后新建会话并完成摘要（孤儿会话无害）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "durakeep-r14b-"));
  try {
    const a = await run(dir, "first", "background.after_create");
    expect(a.code).not.toBe(0);
    const r = result((await run(dir, "second")).out);
    expect(r?.summary).toBe("- 不应该出现的第二次回答"); // 会话是新建的，模型尚未回答过，所以这次确实调用了 faux
    expect(r?.callCount).toBe(1);
    expect(r?.jobs[0]?.status).toBe("succeeded");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);
