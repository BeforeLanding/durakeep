import { expect, test } from "vitest";
import { DbMisuseError, guardDb } from "./guard.ts";
import type { SqlDatabase, SqlExecutor } from "./sql.ts";

// 模拟 chord 的连接队列：事务期间，外层 db 的其他操作排队等待事务结束。
function queueingDb(): SqlDatabase {
  let busy: Promise<void> | undefined;
  const ex: SqlExecutor = {
    exec: async () => {},
    run: async () => {},
    get: async <T extends object>() => ({ v: 1 }) as unknown as T,
    all: async <T extends object>() => [] as T[],
  };
  const queued = async <T>(f: () => Promise<T>): Promise<T> => {
    while (busy) await busy;
    return f();
  };
  return {
    exec: (s) => queued(() => ex.exec(s)),
    run: (s, ...p) => queued(() => ex.run(s, ...p)),
    get: <T extends object>(s: string, ...p: never[]) => queued(() => ex.get<T>(s, ...p)),
    all: <T extends object>(s: string, ...p: never[]) => queued(() => ex.all<T>(s, ...p)),
    close: async () => {},
    transaction: async (cb) => {
      let done!: () => void;
      busy = new Promise<void>((r) => (done = r));
      try {
        return await cb(ex);
      } finally {
        busy = undefined;
        done();
      }
    },
  };
}

type Outcome<T> = { kind: "ok"; v: T } | { kind: "err"; e: unknown } | { kind: "hang" };
const settleOrHang = <T>(p: Promise<T>, ms = 150): Promise<Outcome<T>> =>
  Promise.race([
    p.then(
      (v): Outcome<T> => ({ kind: "ok", v }),
      (e: unknown): Outcome<T> => ({ kind: "err", e }),
    ),
    new Promise<Outcome<T>>((r) => setTimeout(() => r({ kind: "hang" }), ms)),
  ]);

test("未包装的 db：事务回调里调用外层 db 会挂死（复现硬规则 6 的风险）", async () => {
  const db = queueingDb();
  const r = await settleOrHang(db.transaction(async () => db.get("SELECT 1")));
  expect(r.kind).toBe("hang");
});

test("guardDb：同样的误用抛 DbMisuseError，而不是挂死", async () => {
  const db = guardDb(queueingDb());
  const uses: ((d: SqlDatabase) => Promise<unknown>)[] = [
    (d) => d.get("SELECT 1"),
    (d) => d.run("x"),
    (d) => d.all("x"),
    (d) => d.exec("x"),
    (d) => d.transaction(async () => 1),
  ];
  for (const use of uses) {
    const r = await settleOrHang(db.transaction(async () => use(db)));
    expect(r.kind).toBe("err");
    if (r.kind === "err") expect(r.e).toBeInstanceOf(DbMisuseError);
  }
});

test("guardDb：事务句柄正常；事务外的调用不受影响；异步延后的误用同样被抓到", async () => {
  const db = guardDb(queueingDb());
  expect(await db.transaction(async (tx) => (await tx.get<{ v: number }>("SELECT 1"))?.v)).toBe(1);
  expect(await db.get<{ v: number }>("SELECT 1")).toEqual({ v: 1 });
  const r = await settleOrHang(
    db.transaction(async () => {
      await new Promise((res) => setTimeout(res, 10));
      await Promise.resolve();
      return db.get("SELECT 1");
    }),
  );
  expect(r.kind).toBe("err");
});
