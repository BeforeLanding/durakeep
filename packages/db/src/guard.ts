import { AsyncLocalStorage } from "node:async_hooks";
import type { SqlDatabase, SqlExecutor } from "./sql.ts";

export class DbMisuseError extends Error {
  readonly code = "db_used_inside_transaction";
  constructor(op: string) {
    super(`在 db.transaction 回调里调用了外层 db.${op}()：这会永久挂起。请改用回调传入的事务句柄（AGENTS.md 硬规则 6）`);
    this.name = "DbMisuseError";
  }
}

/**
 * 包装一个 SqlDatabase：事务回调（及其异步后续）内再调用外层 db 会抛 DbMisuseError，而不是死锁。
 * 用 AsyncLocalStorage 跟踪“当前异步链是否处于事务回调中”，其他并发的调用不受影响。
 */
export function guardDb(db: SqlDatabase): SqlDatabase {
  const als = new AsyncLocalStorage<true>();
  const check = (op: string) => {
    if (als.getStore() === true) throw new DbMisuseError(op);
  };
  const guarded: SqlDatabase = {
    exec: (sql) => (check("exec"), db.exec(sql)),
    run: (sql, ...p) => (check("run"), db.run(sql, ...p)),
    get: (sql, ...p) => (check("get"), db.get(sql, ...p)),
    all: (sql, ...p) => (check("all"), db.all(sql, ...p)),
    close: () => (check("close"), db.close()),
    transaction: <T>(cb: (tx: SqlExecutor) => Promise<T>) => {
      check("transaction");
      return db.transaction((tx) => als.run(true, () => cb(tx)));
    },
  };
  return guarded;
}
