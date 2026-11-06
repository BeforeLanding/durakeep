import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { migrate } from "./migrate.ts";
import type { SqlDatabase } from "./sql.ts";

// 单测用的极简内存适配器（生产用 chord 的 NodeSqliteDatabase，由 runtime-pi 打开）
function memDb(): SqlDatabase {
  const raw = new DatabaseSync(":memory:");
  const ex = {
    exec: async (s: string) => void raw.exec(s),
    run: async (s: string, ...p: never[]) => void raw.prepare(s).run(...p),
    get: async <T extends object>(s: string, ...p: never[]) => raw.prepare(s).get(...p) as T | undefined,
    all: async <T extends object>(s: string, ...p: never[]) => raw.prepare(s).all(...p) as T[],
  };
  return {
    ...ex,
    transaction: async (cb) => {
      raw.exec("BEGIN");
      try {
        const r = await cb(ex);
        raw.exec("COMMIT");
        return r;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
    close: async () => raw.close(),
  };
}

test("迁移幂等，且只创建 app_ 前缀的表", async () => {
  const db = memDb();
  expect(await migrate(db)).toBe(3);
  expect(await migrate(db)).toBe(0);
  const tables = (await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).map((t) => t.name);
  expect(tables.every((t) => t.startsWith("app_"))).toBe(true);
});
