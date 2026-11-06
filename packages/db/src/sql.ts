// 结构性接口：与 chord 的 SqliteDatabase / SqliteExecutor 兼容，但不 import @earendil-works（ADR-01）。
export type SqlValue = null | number | bigint | string | Uint8Array;

export interface SqlExecutor {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: SqlValue[]): Promise<void>;
  get<T extends object>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  all<T extends object>(sql: string, ...params: SqlValue[]): Promise<T[]>;
}

export interface SqlDatabase extends SqlExecutor {
  transaction<T>(callback: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
