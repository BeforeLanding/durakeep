// 时间换算：本地时间（"YYYY-MM-DDTHH:mm"）+ IANA 时区 ⇄ UTC 毫秒。只用 Intl，不引入依赖。
// 夏令时的“跳过”（本地时间不存在）和“重复”（本地时间出现两次）一律拒绝并说明（T-22），不替用户猜。
import { AppError } from "@durakeep/core";

export const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

export function assertTimezone(tz: unknown): asserts tz is string {
  if (typeof tz !== "string" || tz === "" || tz.length > 64) throw new AppError("invalid_request", "timezone 需为 IANA 时区名，如 Asia/Shanghai", { issues: [{ path: "timezone" }] });
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new AppError("invalid_request", `不认识的时区：${tz}`, { issues: [{ path: "timezone" }] });
  }
  // Intl 接受 "UTC+8" 之类的偏移写法；这里只收 IANA 名（含 "/" 或 UTC / GMT）
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$|^(UTC|GMT|Etc\/.+)$/.test(tz)) throw new AppError("invalid_request", `需为 IANA 时区名：${tz}`, { issues: [{ path: "timezone" }] });
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(utc: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; wd: number } {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
    fmtCache.set(tz, f);
  }
  const m: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(utc))) m[p.type] = p.value;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(m.weekday!);
  return { y: Number(m.year), mo: Number(m.month), d: Number(m.day), h: Number(m.hour), mi: Number(m.minute), wd };
}
/** 时区在该 UTC 时刻的偏移（毫秒，本地 − UTC）。 */
function offsetAt(utc: number, tz: string): number {
  const p = parts(utc, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(utc / 60_000) * 60_000;
}

export function localToUtc(local: unknown, tz: string): number {
  assertTimezone(tz);
  const m = typeof local === "string" ? LOCAL_RE.exec(local) : null;
  if (!m) throw new AppError("invalid_request", "local_datetime 需为 YYYY-MM-DDTHH:mm", { issues: [{ path: "local_datetime" }] });
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(naive);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59) {
    throw new AppError("invalid_request", `日期或时间不存在：${local}`, { issues: [{ path: "local_datetime" }] });
  }
  // 候选：用前后一天的偏移分别反推；只有反算回来仍是同一个本地时间的才是有效解
  const cands = new Set<number>();
  for (const probe of [naive - 86_400_000, naive + 86_400_000]) cands.add(naive - offsetAt(probe, tz));
  const valid = [...cands].filter((u) => {
    const p = parts(u, tz);
    return p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi;
  });
  if (valid.length === 0) throw new AppError("invalid_request", `${(local as string).replace("T", " ")} 在 ${tz} 不存在（夏令时开始时被跳过），请换一个时间`, { issues: [{ path: "local_datetime" }], reason: "dst_gap" });
  if (valid.length > 1) throw new AppError("invalid_request", `${(local as string).replace("T", " ")} 在 ${tz} 出现两次（夏令时结束时重复），请换一个时间或说明是哪一次`, { issues: [{ path: "local_datetime" }], reason: "dst_overlap" });
  return valid[0]!;
}

/** "2026-11-07 20:00 星期六" */
export function describeLocal(utc: number, tz: string): string {
  const p = parts(utc, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)} ${WEEKDAYS[p.wd]}`;
}
