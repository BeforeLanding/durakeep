import { isIP } from "node:net";

// 07 §1.2 / 03 §7：所有解析出的 IP 都必须是公网地址。

/** 把 IPv4 点分十进制转为 32 位无符号整数。 */
function v4ToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // 本网络
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // 链路本地 / 云元数据
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF 协议分配
  ["192.0.2.0", 24], // 文档用
  ["192.88.99.0", 24], // 6to4 中继（已废弃）
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // 基准测试
  ["198.51.100.0", 24], // 文档用
  ["203.0.113.0", 24], // 文档用
  ["224.0.0.0", 3], // 组播 + 保留 + 广播（224.0.0.0 – 255.255.255.255）
];

export function isPublicIPv4(ip: string): boolean {
  const n = v4ToInt(ip);
  return !V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0;
  });
}

/** 展开 IPv6 为 8 个 16 位组；支持 :: 缩写和末尾内嵌的点分 IPv4；无法解析返回 undefined。 */
export function expandIPv6(ip: string): number[] | undefined {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (isIP(s) !== 6) return undefined;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    if (isIP(last) !== 4) return undefined;
    const p = last.split(".").map(Number);
    tail = [(p[0]! << 8) | p[1]!, (p[2]! << 8) | p[3]!];
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const [head, rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const r = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const fill = s.includes("::") ? 8 - h.length - r.length : 0;
  if (fill < 0) return undefined;
  const groups = [...h, ...Array<string>(fill).fill("0"), ...r].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return undefined;
  if (tail.length === 2) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

const v4FromGroups = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

export function isPublicIPv6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return false; // 解析不了就不放行
  const [a, b, c, d, e, f, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g.every((x) => x === 0)) return false; // ::
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g6 === 0 && g7 === 1) return false; // ::1
  // IPv4-mapped ::ffff:a.b.c.d 和 IPv4-compatible ::a.b.c.d：按内嵌的 IPv4 判断
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0xffff || f === 0)) return isPublicIPv4(v4FromGroups(g6, g7));
  // NAT64 64:ff9b::/96：按内嵌的 IPv4 判断
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) return isPublicIPv4(v4FromGroups(g6, g7));
  if ((a & 0xfe00) === 0xfc00) return false; // fc00::/7 唯一本地
  if ((a & 0xffc0) === 0xfe80) return false; // fe80::/10 链路本地
  if ((a & 0xffc0) === 0xfec0) return false; // fec0::/10 站点本地（已废弃）
  if ((a & 0xff00) === 0xff00) return false; // ff00::/8 组播
  if (a === 0x2001 && b === 0x0db8) return false; // 文档用
  if (a === 0x2001 && b === 0) return false; // Teredo：内嵌 IPv4，保守拒绝
  if (a === 0x2002) return isPublicIPv4(v4FromGroups(b, c)); // 6to4：按内嵌的 IPv4 判断
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return false; // 丢弃前缀 100::/64
  return true;
}

export function isPublicIp(ip: string): boolean {
  const v = isIP(ip.startsWith("[") ? ip.slice(1, -1) : ip);
  const bare = ip.startsWith("[") ? ip.slice(1, -1) : ip;
  if (v === 4) return isPublicIPv4(bare);
  if (v === 6) return isPublicIPv6(bare);
  return false;
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata", "instance-data"]);

/** 主机名本身的黑名单（不含 IP 字面量）。解析后的 IP 仍需逐个检查。 */
export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return BLOCKED_HOSTNAMES.has(h) || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local");
}
