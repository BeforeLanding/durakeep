// T-15：写工具的 R2 式崩溃测试 ×20（kb_capture_text、kb_capture_url 各一组）。
// tool.after_business_commit：业务事务（资料 + 作业 + 幂等记录）已提交，结果尚未交给 Pi 时被杀。
// 重启后工具按 replay: "safe" 重跑 → 返回 deduplicated，业务效果只有一次，模型得到正常结果。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { repoRoot, runChild } from "../support/driver.ts";

const script = join(repoRoot, "packages/runtime-pi/src/testing/child-kb.ts");
const REPEAT = Number(process.env.REPEAT ?? 20);

type Out = { status: string; docs: number; jobs: number; ops: number; results: string[]; callCount: number };

for (const tool of ["text", "url"] as const) {
  test(`R2 × ${REPEAT}（kb_capture_${tool}）：业务提交后崩溃 → 重启重跑 → deduplicated，资料 / 作业 / 幂等记录各一条`, async () => {
    const failures: string[] = [];
    for (let i = 0; i < REPEAT; i++) {
      const dir = mkdtempSync(join(tmpdir(), `durakeep-t15-${tool}-`));
      try {
        const env = { DATA_DIR: dir, TOOL: tool };
        const first = await runChild(script, { ...env, SCENARIO: "first", FAULT_POINT: "tool.after_business_commit" });
        if (first.result !== undefined || first.code === 0) failures.push(`#${i} 第一次没有被杀：code=${first.code} ${first.stderr.slice(0, 200)}`);
        const second = await runChild(script, { ...env, SCENARIO: "second" });
        const r = second.result as Out | undefined;
        const body = r?.results[0] ? (JSON.parse(r.results[0]) as { document_id?: string; deduplicated?: boolean }) : undefined;
        const ok =
          r?.status === "done" &&
          r.docs === 1 && // 业务效果只有一次
          r.jobs === 1 &&
          r.ops === 1 &&
          r.results.length === 1 &&
          body?.deduplicated === true && // 重跑时工具返回已完成
          typeof body.document_id === "string" &&
          r.callCount === 1;
        if (!ok) failures.push(`#${i} ${JSON.stringify(r)} stderr=${second.stderr.slice(0, 300)}`);
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);
}
