import { randomBytes } from "node:crypto";

/** UUIDv7：48 位毫秒时间戳 + 随机位，按时间可排序（AGENTS.md：ID 一律 UUIDv7，片段除外）。 */
export function uuidv7(nowMs: number = Date.now()): string {
  const b = randomBytes(16);
  b[0] = (nowMs / 2 ** 40) & 0xff;
  b[1] = (nowMs / 2 ** 32) & 0xff;
  b[2] = (nowMs / 2 ** 24) & 0xff;
  b[3] = (nowMs / 2 ** 16) & 0xff;
  b[4] = (nowMs / 2 ** 8) & 0xff;
  b[5] = nowMs & 0xff;
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
