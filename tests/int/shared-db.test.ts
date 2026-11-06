// K1、K2（ADR-02）：Pi 存储（pi_ 前缀）与 app_ 表共用一个 NodeSqliteDatabase。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "../../packages/runtime-pi/src/testing/faux.ts";
import { afterEach, expect, test } from "vitest";
import { migrate } from "../../packages/db/src/index.ts";
import { context, startPi } from "../../packages/runtime-pi/src/index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "durakeep-db-"));
  dirs.push(d);
  return d;
};
const model = { provider: "faux", modelId: "faux-1" } as const;

test("K1：同一文件里 pi_ 与 app_ 表并存；提交、关闭、重开后两边数据都在", async () => {
  const path = join(tmp(), "app.sqlite");
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage("第一次回答")]);

  let pi = await startPi({ mode: "test", dbPath: path, faux });
  await migrate(pi.db);
  await pi.db.transaction(async (tx) => {
    await tx.run("INSERT INTO app_probe (owner_id, n, note) VALUES (?, ?, ?)", "o1", 1, "业务行");
  });
  const root = await pi.harness.root(context, { agent: { model } });
  const sub = await root.submit({ type: "input", content: "你好", requestId: "k1" }, context);
  expect((await sub.wait(context)).status).toBe("done");
  const rootId = root.id;
  const names = (await pi.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).map((t) => t.name);
  expect(names.some((n) => n.startsWith("pi_"))).toBe(true);
  expect(names.some((n) => n.startsWith("app_"))).toBe(true);
  // 没有无前缀的表：Pi 的表全部带 pi_，业务表全部带 app_
  expect(names.filter((n) => !n.startsWith("pi_") && !n.startsWith("app_"))).toEqual([]);
  await pi.close();

  pi = await startPi({ mode: "test", dbPath: path, faux });
  expect(await migrate(pi.db)).toBe(0);
  const again = await pi.harness.root(context, { agent: { model } });
  expect(again.id).toBe(rootId);
  const entries = await again.entries({}, 50, undefined, context);
  expect(entries.items.map((e) => e.kind)).toContain("pi.assistant");
  // 同一 requestId 找回同一个 submission
  const dup = await again.submit({ type: "input", content: "你好", requestId: "k1" }, context);
  expect(dup.id).toBe(sub.id);
  const row = await pi.db.get<{ note: string }>("SELECT note FROM app_probe WHERE owner_id = ?", "o1");
  expect(row?.note).toBe("业务行");
  expect(faux.state.callCount).toBe(1);
  await pi.close();
});

test("K2：业务事务与 Pi run 交错 1000 次，无死锁、无 ReadAfterWrite", async () => {
  const path = join(tmp(), "app.sqlite");
  const faux = fauxProvider();
  const RUNS = 1000;
  const CONVS = 10;
  faux.setResponses(Array.from({ length: RUNS }, (_, i) => fauxAssistantMessage(`答 ${i}`)));
  const pi = await startPi({ mode: "test", dbPath: path, faux });
  await migrate(pi.db);

  const convs = [];
  for (let i = 0; i < CONVS; i++) convs.push(await pi.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context));

  const errors: Error[] = [];
  const guard = <T>(p: Promise<T>) => p.catch((e: Error) => void errors.push(e));
  const started = Date.now();

  const piWork = convs.map((c, ci) =>
    guard(
      (async () => {
        for (let k = 0; k < RUNS / CONVS; k++) {
          const s = await c.submit({ type: "input", content: `q${ci}-${k}`, requestId: `r${ci}-${k}` }, context);
          const r = await s.wait(context);
          if (r.status !== "done") throw new Error(`run 未完成：${r.status}`);
        }
      })(),
    ),
  );
  // 业务事务：多条语句、中间有 await，与 Pi 的提交争用同一个连接队列
  const bizWork = Array.from({ length: RUNS }, (_, i) =>
    guard(
      pi.db.transaction(async (tx) => {
        await tx.run("INSERT INTO app_probe (owner_id, n) VALUES (?, ?)", "o1", i);
        await new Promise((r) => setImmediate(r));
        const row = await tx.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_probe WHERE owner_id = ?", "o1");
        await tx.run("UPDATE app_probe SET note = ? WHERE n = ? AND owner_id = ?", `c=${row?.c}`, i, "o1");
      }),
    ),
  );
  // 整体加超时，防止死锁时测试无限挂起
  const all = Promise.all([...piWork, ...bizWork]);
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("K2 超时：疑似死锁")), 120_000));
  await Promise.race([all, timeout]);
  const ms = Date.now() - started;
  console.log(`[K2] ${RUNS} 次 Pi run + ${RUNS} 个业务事务，用时 ${ms}ms，错误 ${errors.length}`);

  expect(errors.map((e) => `${e.name}: ${e.message}`)).toEqual([]);
  expect(errors.some((e) => e.name === "ReadAfterWrite")).toBe(false);
  expect(faux.state.callCount).toBe(RUNS);
  const c = await pi.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_probe");
  expect(c?.c).toBe(RUNS);
  await pi.close();
}, 180_000);
