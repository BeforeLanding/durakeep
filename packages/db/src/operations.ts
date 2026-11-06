import { AppError, canonicalJson, type Json } from "@durakeep/core";
import type { SqlDatabase, SqlExecutor } from "./sql.ts";

export type OnceResult<T extends Json> = { result: T; deduplicated: boolean };

/**
 * ADR-04：在一个业务事务里完成“查询 → 执行 → 保存结果”。
 * fn 必须只使用传入的事务句柄；已有记录时不执行 fn，直接返回保存的结果。
 */
export async function once<T extends Json>(
  db: SqlDatabase,
  ownerId: string,
  key: string,
  tool: string,
  args: Json,
  fn: (tx: SqlExecutor) => Promise<T>,
): Promise<OnceResult<T>> {
  return db.transaction(async (tx) => {
    const hit = await tx.get<{ result_json: string }>(
      "SELECT result_json FROM app_operations WHERE owner_id = ? AND op_key = ?",
      ownerId,
      key,
    );
    if (hit) return { result: JSON.parse(hit.result_json) as T, deduplicated: true };
    const result = await fn(tx);
    await tx.run(
      "INSERT INTO app_operations (owner_id, op_key, tool, args_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ownerId,
      key,
      tool,
      JSON.stringify(args),
      JSON.stringify(result),
      Date.now(),
    );
    return { result, deduplicated: false };
  });
}

/**
 * 请求级幂等（06 §1）：同一个 key + 同样的参数 → 返回第一次的结果；同一个 key + 不同参数 → 409 idempotency_conflict。
 * 与 once() 共用 app_operations 表；key 的命名空间由调用方保证（如 "http:capture:<client_request_id>"）。
 */
export async function onceStrict<T extends Json>(
  db: SqlDatabase,
  ownerId: string,
  key: string,
  tool: string,
  args: Json,
  fn: (tx: SqlExecutor) => Promise<T>,
): Promise<OnceResult<T>> {
  return db.transaction(async (tx) => {
    const hit = await tx.get<{ args_json: string; result_json: string }>(
      "SELECT args_json, result_json FROM app_operations WHERE owner_id = ? AND op_key = ?",
      ownerId,
      key,
    );
    if (hit) {
      if (canonicalJson(JSON.parse(hit.args_json) as Json) !== canonicalJson(args)) {
        throw new AppError("idempotency_conflict", "同一个请求 ID 对应了不同的内容");
      }
      return { result: JSON.parse(hit.result_json) as T, deduplicated: true };
    }
    const result = await fn(tx);
    await tx.run(
      "INSERT INTO app_operations (owner_id, op_key, tool, args_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ownerId,
      key,
      tool,
      canonicalJson(args),
      JSON.stringify(result),
      Date.now(),
    );
    return { result, deduplicated: false };
  });
}
