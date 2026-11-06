import { AppError } from "@durakeep/core";
import type { Context } from "hono";

export async function readJson(c: Context, optional = false): Promise<unknown> {
  if (optional && (await c.req.raw.clone().text()) === "") return null;
  try {
    return await c.req.json();
  } catch {
    throw new AppError("invalid_request", "请求体不是有效的 JSON");
  }
}

/** 解析 ?limit=（1–100）；缺省返回 undefined。 */
export function parseLimit(raw: string | undefined, max = 100): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new AppError("invalid_request", `limit 需为 1–${max} 的整数`, { issues: [{ path: "limit" }] });
  }
  return n;
}
