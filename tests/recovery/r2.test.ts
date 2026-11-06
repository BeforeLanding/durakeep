// R2：写工具在业务事务提交后崩溃（tool.after_business_commit），重复 20 次。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { repoRoot, runChild } from "../support/driver.ts";

const script = join(repoRoot, "packages/runtime-pi/src/testing/child-write.ts");
const REPEAT = 20;

type ToolLog = { deduplicated: boolean; opKey: string };

test(`R2 × ${REPEAT}：重启后工具重跑返回 deduplicated；业务效果只有一次`, async () => {
  const failures: string[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const dir = mkdtempSync(join(tmpdir(), "durakeep-r2-"));
    try {
      const first = await runChild(script, {
        DATA_DIR: dir,
        SCENARIO: "first",
        FAULT_POINT: "tool.after_business_commit",
      });
      if (first.result !== undefined || first.code === 0) failures.push(`#${i} 第一次没有被杀`);
      const second = await runChild(script, { DATA_DIR: dir, SCENARIO: "second" });
      const res = second.result as
        | { status: string; probeRows: number; opRows: number; callCount: number }
        | undefined;
      const log = readFileSync(join(dir, "tool.log"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as ToolLog);
      const ok =
        res?.status === "done" &&
        res.probeRows === 1 &&
        res.opRows === 1 &&
        res.callCount === 1 &&
        log.length === 2 &&
        log[0]!.deduplicated === false &&
        log[1]!.deduplicated === true &&
        log[0]!.opKey === log[1]!.opKey;
      if (!ok) failures.push(`#${i} ${JSON.stringify(res)} log=${JSON.stringify(log)} stderr=${second.stderr.slice(0, 300)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  expect(failures).toEqual([]);
}, 600_000);
