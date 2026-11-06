// K5、K6（ADR-05、05 §6）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { migrate } from "../../packages/db/src/index.ts";
import { context, startPi } from "../../packages/runtime-pi/src/index.ts";
import { fauxAssistantMessage, fauxProvider } from "../../packages/runtime-pi/src/testing/faux.ts";
import { profileSpikeExtension } from "../../packages/runtime-pi/src/testing/section-spike.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "durakeep-sec-"));
  dirs.push(d);
  return d;
};
const model = { provider: "faux", modelId: "faux-1" } as const;

test("K5：偏好不变时连续 10 次请求不追加 pi.system；偏好变化后追加 1 次", async () => {
  const faux = fauxProvider();
  faux.setResponses(Array.from({ length: 12 }, (_, i) => fauxAssistantMessage(`答${i}`)));
  const renders = { n: 0 };
  const dir = tmp();
  const pi2 = await startPi({
    mode: "test",
    dbPath: join(dir, "app.sqlite"),
    faux,
    extensionsFactory: (db) => [profileSpikeExtension(db, renders)],
  });
  await migrate(pi2.db);
  await pi2.db.run("INSERT INTO app_probe (owner_id, n, note) VALUES (?, ?, ?)", "o1", 1, "[review.verbosity] 每周回顾简短");
  const root = await pi2.harness.root(context, { agent: { model } });

  const systemCount = async () => {
    const page = await root.entries({}, 200, undefined, context);
    return page.items.filter((e) => e.kind === "pi.system").length;
  };
  for (let i = 0; i < 10; i++) {
    const s = await root.submit({ type: "input", content: `问${i}`, requestId: `q${i}` }, context);
    expect((await s.wait(context)).status).toBe("done");
  }
  const afterTen = await systemCount();
  console.log(`[K5] 10 次请求后 pi.system=${afterTen}，section 渲染 ${renders.n} 次`);
  expect(afterTen).toBe(1); // 第一次请求写入一次，其后不再追加
  expect(renders.n).toBeGreaterThanOrEqual(10); // 每次请求都重新渲染（读库），但文本不变所以不追加

  await pi2.db.run("INSERT INTO app_probe (owner_id, n, note) VALUES (?, ?, ?)", "o1", 2, "[answer.lang] 用中文");
  const s11 = await root.submit({ type: "input", content: "问10", requestId: "q10" }, context);
  expect((await s11.wait(context)).status).toBe("done");
  expect(await systemCount()).toBe(2); // 偏好变化后恰好追加 1 次
  const s12 = await root.submit({ type: "input", content: "问11", requestId: "q11" }, context);
  expect((await s12.wait(context)).status).toBe("done");
  expect(await systemCount()).toBe(2);
  await pi2.close();
});

test("K6（探测）：带 requestId 的 write 是否去重", async () => {
  const dir = tmp();
  const path = join(dir, "app.sqlite");
  const faux = fauxProvider();
  let pi = await startPi({ mode: "test", dbPath: path, faux });
  const root = await pi.harness.root(context, { agent: { model } });
  const countFired = async (r = root) => {
    const page = await r.entries({}, 200, undefined, context);
    return page.items.filter((e) => e.kind === "app.reminder_fired").map((e) => (e.data as { n: number }).n);
  };
  const write = (r: typeof root, n: number, requestId: string) =>
    r.submit({ type: "write", entry: { kind: "app.reminder_fired", data: { n } }, requestId }, context);

  const a1 = await write(root, 1, "occ:1");
  const a2 = await write(root, 1, "occ:1"); // 同 id 同内容
  const a3 = await write(root, 2, "occ:1"); // 同 id 不同内容
  const sameSubmission = a1.id === a2.id && a2.id === a3.id;
  const afterIdle = await countFired();

  const b = await write(root, 3, "occ:2");
  await b.wait(context);
  const afterWait = await countFired();

  await pi.close();
  pi = await startPi({ mode: "test", dbPath: path, faux });
  const root2 = await pi.harness.root(context, { agent: { model } });
  const c = await write(root2, 3, "occ:2"); // 重启后重投
  const afterRestart = await countFired(root2);
  console.log(`[K6] 同 id 的 submission 相同=${sameSubmission}；空闲时三次写入后 entries=${JSON.stringify(afterIdle)}；occ:2 写入后=${JSON.stringify(afterWait)}；重启后重投 occ:2：submission 相同=${c.id === b.id}，entries=${JSON.stringify(afterRestart)}`);

  // 观察结果固定为断言：write 带 requestId 时去重（含重启之后、含内容不同）
  expect(sameSubmission).toBe(true);
  expect(afterIdle).toEqual([1]);
  expect(afterRestart.sort()).toEqual([1, 3]);
  expect(c.id).toBe(b.id);
  await pi.close();
});

test("K6（探测）：会话忙时的 write 同样按 requestId 去重", async () => {
  const faux = fauxProvider({ tokensPerSecond: 20 }); // 让回答慢一点，保证写入发生在 run 期间
  faux.setResponses([fauxAssistantMessage("这是一段稍长的回答，用来占住会话。".repeat(3))]);
  const pi = await startPi({ mode: "test", dbPath: join(tmp(), "app.sqlite"), faux });
  const root = await pi.harness.root(context, { agent: { model } });
  const run = await root.submit({ type: "input", content: "占住会话", requestId: "busy" }, context);
  const live = await pi.harness.snapshot(
    (await import("../../packages/runtime-pi/src/testing/docs.ts")).LiveDoc, root.id, context);
  const busyAtWrite = live?.run !== undefined;
  const w = (n: number) => root.submit({ type: "write", entry: { kind: "app.reminder_fired", data: { n } }, requestId: "occ:busy" }, context);
  const w1 = await w(1);
  const w2 = await w(1);
  await run.wait(context);
  const page = await root.entries({}, 200, undefined, context);
  const fired = page.items.filter((e) => e.kind === "app.reminder_fired").length;
  console.log(`[K6 忙] 写入时 run 进行中=${busyAtWrite}；两次写入同一 submission=${w1.id === w2.id}；entries=${fired}`);
  expect(busyAtWrite).toBe(true);
  expect(w1.id).toBe(w2.id);
  expect(fired).toBe(1);
  await pi.close();
});
