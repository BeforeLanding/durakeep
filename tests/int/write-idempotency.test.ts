// K4（ADR-04）：run 锚点可读；同 run 同参得到同一 op_key；不同 run 不同 op_key。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { migrate } from "../../packages/db/src/index.ts";
import { context, startPi } from "../../packages/runtime-pi/src/index.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../../packages/runtime-pi/src/testing/faux.ts";
import { writeSpikeExtension, type WriteSpikeLog } from "../../packages/runtime-pi/src/write-tool-spike.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const model = { provider: "faux", modelId: "faux-1" } as const;
const toolRound = (text: string) =>
  fauxAssistantMessage(fauxToolCall("probe_write", { text }), { stopReason: "toolUse" });

test("K4：锚点可读；同 run 内相同参数（含首尾空白差异）→ 同 op_key 且第二次 deduplicated；新 run → 新 op_key、新效果", async () => {
  const dir = mkdtempSync(join(tmpdir(), "durakeep-k4-"));
  dirs.push(dir);
  const logs: Parameters<WriteSpikeLog>[0][] = [];
  const faux = fauxProvider();
  faux.setResponses([
    toolRound(" x "), // run 1，第 1 轮
    toolRound("x"), //   run 1，第 2 轮：模型用（规范化后）相同参数再调一次
    fauxAssistantMessage("run1 完成"),
    toolRound("x"), //   run 2：用户新一轮要求
    fauxAssistantMessage("run2 完成"),
  ]);
  const pi = await startPi({
    mode: "test",
    dbPath: join(dir, "app.sqlite"),
    faux,
    extensionsFactory: (db) => [writeSpikeExtension(db, (e) => logs.push(e))],
  });
  await migrate(pi.db);
  const root = await pi.harness.root(context, { agent: { model } });
  for (const [i, content] of ["第一次请求", "第二次请求"].entries()) {
    const s = await root.submit({ type: "input", content, requestId: `k4-${i}` }, context);
    expect((await s.wait(context)).status).toBe("done");
  }
  console.log(
    `[K4] ${JSON.stringify(logs.map((l) => ({ anchor: l.anchor, dedup: l.deduplicated, key: l.opKey.slice(0, 8) })))}`,
  );
  expect(logs).toHaveLength(3);
  expect(logs.every((l) => l.anchor !== undefined)).toBe(true); // 锚点可读
  expect(logs[0]!.opKey).toBe(logs[1]!.opKey); // 同 run、同参数
  expect(logs[0]!.anchor).toBe(logs[1]!.anchor);
  expect(logs.map((l) => l.deduplicated)).toEqual([false, true, false]);
  expect(logs[2]!.anchor).not.toBe(logs[0]!.anchor); // 不同 run → 不同锚点
  expect(logs[2]!.opKey).not.toBe(logs[0]!.opKey);
  const rows = await pi.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_probe WHERE note = 'x'");
  expect(rows?.c).toBe(2); // run1 一次 + run2 一次
  await pi.close();
});
