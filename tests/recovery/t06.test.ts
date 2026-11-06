// T-06：R1、R3，每个用例重复 20 次（经由 RuntimePort）。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { repoRoot, runChild } from "../support/driver.ts";

const script = join(repoRoot, "packages/runtime-pi/src/testing/child-port.ts");
const REPEAT = Number(process.env.REPEAT ?? 20);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `durakeep-${p}-`));

test(`R1 × ${REPEAT}：Pi 已接纳、响应丢失，客户端重发 → 只有一个 submission、一条用户消息`, async () => {
  const failures: string[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const dir = tmp("r1");
    try {
      const first = await runChild(script, { DATA_DIR: dir, SCENARIO: "r1-first", FAULT_POINT: "ingress.after_submit" });
      if (first.result !== undefined || first.code === 0) failures.push(`#${i} 第一次没有被杀：${first.stdout} ${first.stderr.slice(0, 200)}`);
      const second = await runChild(script, { DATA_DIR: dir, SCENARIO: "r1-second" });
      const r = second.result as { same: boolean; status: string; users: number } | undefined;
      if (!r || !r.same || r.status !== "done" || r.users !== 1) failures.push(`#${i} ${JSON.stringify(r)} ${second.stderr.slice(0, 300)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  expect(failures).toEqual([]);
}, 600_000);

test(`R3 × ${REPEAT}：模型流式输出中崩溃 → 按 retry 继续并完成，不卡在“生成中”`, async () => {
  const failures: string[] = [];
  const timings: number[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const dir = tmp("r3");
    try {
      const first = await runChild(script, { DATA_DIR: dir, SCENARIO: "r3-first", FAULT_POINT: "model.mid_stream" });
      if (first.result !== undefined || first.code === 0) failures.push(`#${i} 第一次没有在流式中被杀：${first.stdout} ${first.stderr.slice(0, 200)}`);
      const second = await runChild(script, { DATA_DIR: dir, SCENARIO: "r3-second" }, 90_000);
      const r = second.result as
        | { status: string; ms: number; running: boolean; runFailure?: unknown; callCount: number; assistants: string[] }
        | undefined;
      if (r) timings.push(r.ms);
      const ok = r && r.status === "done" && r.running === false && r.runFailure === undefined && r.callCount === 1 && r.assistants.at(-1) === "完成";
      if (!ok) failures.push(`#${i} ${JSON.stringify(r)} ${second.stderr.slice(0, 300)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`[R3] 重启后到完成的耗时(ms)：min=${Math.min(...timings)} max=${Math.max(...timings)}`);
  expect(failures).toEqual([]);
}, 900_000);
