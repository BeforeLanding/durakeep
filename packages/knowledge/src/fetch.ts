import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { AppError } from "@durakeep/core";
import { parseRobots, robotsAllows } from "./robots.ts";
import { isBlockedHostname, isPublicIp } from "./ssrf.ts";

// 07 §1.2：协议白名单、DNS 解析后检查所有 IP、手动重定向且每跳重新检查、连接固定在已检查的 IP、大小与时间上限。

// HTTP 头只能是 Latin-1：07 §1.2 原写的中文说明会让 Node 直接抛 ERR_INVALID_CHAR，所以用纯 ASCII
export const USER_AGENT = "PersonalAgent/0.1 (+personal local use)";
const UA_TOKEN = "PersonalAgent";
export const ACCEPT_TYPES = ["text/html", "text/plain", "text/markdown", "application/xhtml+xml"];

export type FetchPolicy = {
  /** 主机名 → IP 列表。每一跳只调用一次，调用之后连接固定在检查过的 IP 上（防 DNS 重绑定）。 */
  resolve: (host: string) => Promise<string[]>;
  isPublicIp: (ip: string) => boolean;
  maxBytes: number;
  timeoutMs: number;
  maxRedirects: number;
  userAgent: string;
  /** 允许的 Content-Type（媒体类型部分）；undefined 表示不限制（robots.txt 用）。 */
  acceptTypes: string[] | undefined;
};

export const DEFAULT_POLICY: FetchPolicy = {
  resolve: async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address),
  isPublicIp,
  maxBytes: 5 * 1024 * 1024,
  timeoutMs: 20_000,
  maxRedirects: 5,
  userAgent: USER_AGENT,
  acceptTypes: ACCEPT_TYPES,
};

export type FetchResult = { finalUrl: string; status: number; contentType: string | undefined; bytes: Uint8Array };

const blocked = (msg: string, details: Record<string, unknown> = {}) => new AppError("ssrf_blocked", msg, details);
/** retryable：网络抖动、超时、5xx / 429 值得重试；4xx 和策略性拒绝不值得。 */
const failed = (msg: string, retryable: boolean, details: Record<string, unknown> = {}) =>
  new AppError("fetch_failed", msg, { ...details, retryable });

type Hop =
  | { kind: "redirect"; location: string }
  | { kind: "done"; status: number; contentType: string | undefined; bytes: Uint8Array };

async function hop(url: URL, p: FetchPolicy, deadline: number, allowedPorts: Set<number>): Promise<Hop> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw blocked("只支持 http 和 https 链接");
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!allowedPorts.has(port)) throw blocked("不允许访问该端口", { port });
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (isBlockedHostname(host)) throw blocked("不允许访问该主机");

  // 解析一次，全部 IP 都必须是公网地址；之后连接固定在 pinned 上，不再触发第二次 DNS 解析
  let ips: string[];
  if (isIP(host) !== 0) ips = [host];
  else {
    try {
      ips = await p.resolve(host);
    } catch {
      throw failed("无法解析域名", true, { reason: "dns" });
    }
  }
  if (ips.length === 0) throw failed("无法解析域名", true, { reason: "dns" });
  for (const ip of ips) if (!p.isPublicIp(ip)) throw blocked("目标地址不是公网地址");
  const pinned = ips[0]!;
  const family = isIP(pinned);

  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new AppError("fetch_timeout", "抓取超时", { retryable: true });
  const requestFn = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise<Hop>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = requestFn(
      {
        host, // 用于 Host 头和 TLS SNI / 证书校验
        port,
        path: url.pathname + url.search,
        method: "GET",
        headers: { "user-agent": p.userAgent, accept: (p.acceptTypes ?? ["*/*"]).join(", "), "accept-encoding": "identity" },
        // 连接固定在已检查的 IP：无论系统再解析出什么都不使用
        lookup: (_h, o, cb) => {
          const opts = o as { all?: boolean };
          if (opts.all) (cb as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: pinned, family }]);
          else (cb as (e: null, a: string, f: number) => void)(null, pinned, family);
        },
        agent: false,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const loc = res.headers.location;
        if (status >= 300 && status < 400 && loc) {
          res.destroy();
          return done(() => resolve({ kind: "redirect", location: loc }));
        }
        if (status < 200 || status >= 300) {
          res.destroy();
          const retryable = status === 408 || status === 429 || status >= 500;
          return done(() => reject(failed(`目标网站返回 HTTP ${status}`, retryable, { status })));
        }
        const contentType = res.headers["content-type"];
        const media = contentType?.split(";")[0]?.trim().toLowerCase();
        if (p.acceptTypes && !(media && p.acceptTypes.includes(media))) {
          res.destroy();
          return done(() => reject(new AppError("unsupported_type", "不支持的内容类型", { content_type: media ?? null })));
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > p.maxBytes) {
          res.destroy();
          return done(() => reject(new AppError("too_large", "内容超过大小限制", { limit: p.maxBytes })));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > p.maxBytes) {
            res.destroy(); // 流式计数，超出立即中断
            return done(() => reject(new AppError("too_large", "内容超过大小限制", { limit: p.maxBytes })));
          }
          chunks.push(c);
        });
        res.on("end", () => done(() => resolve({ kind: "done", status, contentType, bytes: new Uint8Array(Buffer.concat(chunks)) })));
        res.on("error", () => done(() => reject(failed("读取响应时连接中断", true))));
        res.on("close", () => done(() => reject(failed("读取响应时连接中断", true))));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(() => reject(new AppError("fetch_timeout", "抓取超时", { retryable: true })));
    }, remaining);
    req.on("error", () => done(() => reject(failed("无法连接到目标网站", true, { reason: "connect" }))));
    req.end();
  });
}

/**
 * 带 SSRF 防护的单页抓取。重定向手动处理，每一跳都重新检查协议、端口、主机名与全部解析出的 IP。
 * 失败一律抛 AppError：ssrf_blocked / unsupported_type / too_large / fetch_timeout / fetch_failed。
 */
export async function safeFetch(rawUrl: string, overrides: Partial<FetchPolicy> = {}): Promise<FetchResult> {
  const p: FetchPolicy = { ...DEFAULT_POLICY, ...overrides };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError("invalid_request", "URL 无效");
  }
  const deadline = Date.now() + p.timeoutMs; // 总时长（含所有重定向）
  const firstPort = url.port === "" ? undefined : Number(url.port);
  const allowedPorts = new Set<number>([80, 443, ...(firstPort !== undefined ? [firstPort] : [])]);
  for (let i = 0; i <= p.maxRedirects; i++) {
    const r = await hop(url, p, deadline, allowedPorts);
    if (r.kind === "done") return { finalUrl: url.toString(), status: r.status, contentType: r.contentType, bytes: r.bytes };
    try {
      url = new URL(r.location, url);
    } catch {
      throw failed("重定向地址无效", false, { reason: "bad_redirect" });
    }
    url.hash = "";
  }
  throw failed("重定向次数过多", false, { reason: "too_many_redirects" });
}

/**
 * robots.txt：只遵守 Disallow / Allow（07 §1.2）。拿不到 robots.txt（404、超时、5xx 等）按允许处理；
 * robots.txt 本身的 SSRF 被拦截不吞掉——抛出 ssrf_blocked。
 */
export async function assertRobotsAllows(target: string, overrides: Partial<FetchPolicy> = {}): Promise<void> {
  const url = new URL(target);
  const robotsUrl = new URL("/robots.txt", url);
  let text: string;
  try {
    const r = await safeFetch(robotsUrl.toString(), { ...overrides, acceptTypes: undefined, maxBytes: 512 * 1024, timeoutMs: Math.min(5_000, overrides.timeoutMs ?? 5_000) });
    text = new TextDecoder().decode(r.bytes);
  } catch (e) {
    if (e instanceof AppError && e.code === "ssrf_blocked") throw e;
    return;
  }
  if (!robotsAllows(parseRobots(text, UA_TOKEN), url.pathname + url.search)) {
    throw new AppError("robots_disallowed", "该网站的 robots.txt 不允许抓取此页面；可以改为粘贴正文");
  }
}
