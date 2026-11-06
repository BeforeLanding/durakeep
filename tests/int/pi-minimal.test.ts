import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { runChild, repoRoot } from "../support/driver.ts";

const script = join(repoRoot, "packages/runtime-pi/src/testing/child-chat.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "durakeep-"));
  dirs.push(d);
  return d;
};

test("无故障：faux + SQLite 跑通 工具调用 → 回答", async () => {
  const dir = tmp();
  const r = await runChild(script, { DATA_DIR: dir, SCENARIO: "first" });
  expect(r.code, r.stderr).toBe(0);
  expect(r.result).toMatchObject({ status: "done", callCount: 2 });
  expect((r.result as { kinds: string[] }).kinds).toContain("pi.tool-result");
});

test("故障：工具内被 SIGKILL，重启后已提交条目仍在，run 继续完成", async () => {
  const dir = tmp();
  const first = await runChild(script, { DATA_DIR: dir, SCENARIO: "first", FAULT_POINT: "tool.in_execute" });
  expect(first.result).toBeUndefined(); // 没来得及输出
  expect(first.signal === "SIGKILL" || first.code !== 0).toBe(true);

  const second = await runChild(script, { DATA_DIR: dir, SCENARIO: "second" });
  expect(second.code, second.stderr).toBe(0);
  const res = second.result as { status: string; kinds: string[]; callCount: number };
  expect(res.status).toBe("done");
  expect(res.kinds).toContain("pi.user"); // 被杀之前已提交
  // 工具声明 replay: "safe"：重启后重跑，模型只被再请求 1 次
  expect(res.callCount).toBe(1);
  const runs = readFileSync(join(dir, "tool-executions.log"), "utf8").trim().split("\n");
  expect(runs).toEqual(["hi", "hi"]); // 第一次被杀，第二次重跑
});
