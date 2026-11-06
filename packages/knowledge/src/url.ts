import { createHash } from "node:crypto";
import { AppError } from "@durakeep/core";

// 07 §1.1：追踪参数一律去掉
const TRACKING_EXACT = new Set(["spm", "from", "fbclid", "gclid", "mc_cid", "mc_eid", "igshid", "share_source", "yclid", "msclkid"]);
const isTracking = (k: string) => k.toLowerCase().startsWith("utm_") || TRACKING_EXACT.has(k.toLowerCase());

/**
 * URL 规范化：小写 scheme / host；去掉默认端口、#fragment、追踪参数；其余 query 参数按键排序（同键保持原顺序）。
 * 只接受 http / https，不接受带用户名口令的 URL。结果用作 source_uri 的唯一性判断。
 */
export function normalizeUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new AppError("invalid_request", "URL 无效", { issues: [{ path: "url" }] });
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new AppError("invalid_request", "只支持 http 和 https 链接", { issues: [{ path: "url" }] });
  }
  if (u.username !== "" || u.password !== "") {
    throw new AppError("invalid_request", "链接中不能包含用户名或口令", { issues: [{ path: "url" }] });
  }
  u.hash = "";
  const kept = [...u.searchParams.entries()].filter(([k]) => !isTracking(k));
  const sorted = kept.map((kv, i) => ({ kv, i })).sort((a, b) => (a.kv[0] < b.kv[0] ? -1 : a.kv[0] > b.kv[0] ? 1 : a.i - b.i));
  u.search = "";
  for (const { kv } of sorted) u.searchParams.append(kv[0], kv[1]);
  // URL 已把 scheme / host 转小写、去掉默认端口、把 IDN 转为 punycode
  return u.toString();
}

export function urlHash(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}
