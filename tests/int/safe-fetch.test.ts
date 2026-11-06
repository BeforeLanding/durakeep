// S6–S9（08 §6）：SSRF 防护与抓取限制。用本机 HTTP 服务模拟“公网站点”；
// 测试策略把 127.0.0.1 当作“公网”、10.0.0.x 当作“内网”，以便在没有真实公网的环境里验证每一条规则。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { AppError } from "../../packages/core/src/index.ts";
import { assertRobotsAllows, DEFAULT_POLICY, safeFetch, USER_AGENT, type FetchPolicy } from "../../packages/knowledge/src/fetch.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
});

async function serve(handler: Handler): Promise<{ port: number; base: string; hits: () => number }> {
  let hits = 0;
  const s = createServer((req, res) => {
    hits++;
    handler(req, res);
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  return { port, base: `http://127.0.0.1:${port}`, hits: () => hits };
}

/** 测试策略：127.0.0.1 = “公网”；主机名由 table 解析（未登记的按 DNS 失败处理）。 */
function policy(table: Record<string, string[] | (() => string[])> = {}, extra: Partial<FetchPolicy> = {}): Partial<FetchPolicy> {
  return {
    isPublicIp: (ip) => ip === "127.0.0.1",
    resolve: async (host) => {
      const v = table[host];
      if (!v) throw new Error("ENOTFOUND");
      return typeof v === "function" ? v() : v;
    },
    ...extra,
  };
}

const html = (res: ServerResponse, body = "<html><body>ok</body></html>", type = "text/html; charset=utf-8") => {
  res.writeHead(200, { "content-type": type });
  res.end(body);
};
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "no-error";
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
};

test("S6：loopback、私网、元数据地址、localhost 及各种写法在默认策略下被拒绝，且根本没有发起连接", async () => {
  const local = await serve((_req, res) => html(res));
  const targets = [
    local.base, // 127.0.0.1:port —— 真的有服务在监听，默认策略也不能连
    "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://192.168.1.1/",
    "http://172.16.0.1/", "http://100.64.0.1/", "http://0.0.0.0/", "http://localhost/", `http://localhost:${local.port}/`,
    "http://metadata.google.internal/computeMetadata/v1/", "http://foo.localhost/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/",
    "http://2130706433/", "http://0x7f.0.0.1/", "http://127.1/", "http://017700000001/", "http://[fe80::1]/", "http://[fd00::1]/",
    "ftp://example.com/x", "file:///etc/passwd",
  ];
  for (const t of targets) expect(await code(safeFetch(t)), t).toBe("ssrf_blocked");
  expect(local.hits()).toBe(0);
});

test("S6 补充：域名解析到内网 / 混合了内网地址（任何一个 IP 不是公网即拒绝）", async () => {
  const local = await serve((_req, res) => html(res));
  const p = policy({ "evil.test": ["10.0.0.9"], "mixed.test": ["127.0.0.1", "10.0.0.9"], "mixed2.test": ["10.0.0.9", "127.0.0.1"], "good.test": ["127.0.0.1"] });
  expect(await code(safeFetch(`http://evil.test:${local.port}/`, p))).toBe("ssrf_blocked");
  expect(await code(safeFetch(`http://mixed.test:${local.port}/`, p))).toBe("ssrf_blocked");
  expect(await code(safeFetch(`http://mixed2.test:${local.port}/`, p))).toBe("ssrf_blocked");
  expect(local.hits()).toBe(0);
  const ok = await safeFetch(`http://good.test:${local.port}/`, p);
  expect(ok.status).toBe(200);
  expect(local.hits()).toBe(1);
});

test("S7：公网 URL 302 跳转到内网 / 元数据 / file:// 被拒绝，且不会连接跳转目标；多跳合法重定向正常", async () => {
  const hitsOnTarget: string[] = [];
  const target = await serve((req, res) => { hitsOnTarget.push(req.url ?? ""); html(res, "secret"); });
  let redirectTo = "";
  const a = await serve((req, res) => {
    if (req.url === "/ok1") { res.writeHead(302, { location: "/ok2" }); return res.end(); }
    if (req.url === "/ok2") { res.writeHead(301, { location: "/final" }); return res.end(); }
    if (req.url === "/final") return html(res, "<html><body>final</body></html>");
    res.writeHead(302, { location: redirectTo });
    res.end();
  });
  // “公网”只有 127.0.0.1:a.port 这一个端口被允许（target 在另一个端口 → 端口规则 + 策略都会挡）
  const p = policy({ "pub.test": ["127.0.0.1"], "priv.test": ["10.0.0.7"] });
  for (const loc of [
    "http://10.0.0.1/admin", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "file:///etc/passwd", "ftp://example.com/x",
    "http://priv.test/", `http://127.0.0.1:${target.port}/secret`, "http://localhost/", "http://3232235777/", "http://0xc0a80101/",
  ]) {
    redirectTo = loc;
    expect(await code(safeFetch(`http://pub.test:${a.port}/go`, p)), loc).toBe("ssrf_blocked");
  }
  expect(hitsOnTarget).toEqual([]); // 从未连接过跳转目标
  const r = await safeFetch(`http://pub.test:${a.port}/ok1`, p);
  expect([r.status, new URL(r.finalUrl).pathname]).toEqual([200, "/final"]);
});

test("S8：DNS 重绑定——每跳只解析一次、连接固定在已检查的 IP；先公网后内网的解析结果不会被使用", async () => {
  const seenHost: string[] = [];
  const s = await serve((req, res) => { seenHost.push(req.headers.host ?? ""); html(res); });
  let calls = 0;
  const p = policy({ "rebind.test": () => (++calls === 1 ? ["127.0.0.1"] : ["10.0.0.1"]) });
  const r = await safeFetch(`http://rebind.test:${s.port}/page`, p);
  expect(r.status).toBe(200);
  expect(calls).toBe(1); // 没有第二次解析
  expect(seenHost).toEqual([`rebind.test:${s.port}`]); // Host 头仍是原主机名
  expect(s.hits()).toBe(1);

  // 重定向的下一跳重新解析并检查：这一次拿到的是内网地址 → 拒绝
  calls = 0;
  const t = await serve((_req, res) => { res.writeHead(302, { location: `http://rebind2.test:${t.port}/next` }); res.end(); });
  let n2 = 0;
  const p2 = policy({ "first.test": ["127.0.0.1"], "rebind2.test": () => (++n2 === 1 ? ["10.0.0.3"] : ["127.0.0.1"]) });
  expect(await code(safeFetch(`http://first.test:${t.port}/`, p2))).toBe("ssrf_blocked");
  expect(t.hits()).toBe(1); // 只访问了第一跳
});

test("S8 补充：连接用的是固定的 IP，而不是系统再次解析的结果（lookup 被替换）", async () => {
  const s = await serve((_req, res) => html(res));
  // 域名在系统 DNS 里根本不存在；能连上说明连接走的是固定 IP，没有触发系统解析
  const r = await safeFetch(`http://never-resolves.invalid:${s.port}/`, policy({ "never-resolves.invalid": ["127.0.0.1"] }));
  expect(r.status).toBe(200);
});

test("S9：响应体超过 5 MB（流式计数）立即中断；声明的 Content-Length 超限直接拒绝", async () => {
  let streamed = 0;
  let aborted = false;
  const big = await serve((req, res) => {
    if (req.url === "/declared") { res.writeHead(200, { "content-type": "text/plain", "content-length": String(6 * 1024 * 1024) }); return res.end(); }
    res.writeHead(200, { "content-type": "text/plain" }); // chunked，不声明长度
    const chunk = Buffer.alloc(256 * 1024, 97);
    res.on("close", () => { aborted = true; });
    const tick = () => {
      if (res.destroyed || res.writableEnded) return;
      streamed += chunk.length;
      if (streamed >= 40 * 1024 * 1024) return res.end();
      res.write(chunk, () => setImmediate(tick));
    };
    tick();
  });
  expect(DEFAULT_POLICY.maxBytes).toBe(5 * 1024 * 1024);
  expect(await code(safeFetch(`${big.base}/stream`, policy()))).toBe("too_large");
  await new Promise((r) => setTimeout(r, 100));
  expect(aborted).toBe(true);
  expect(streamed).toBeLessThan(16 * 1024 * 1024); // 远没有把 40 MB 读完
  expect(await code(safeFetch(`${big.base}/declared`, policy()))).toBe("too_large");
  // 5 MB 以内正常
  const ok = await serve((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(Buffer.alloc(1024 * 1024, 98)); });
  expect((await safeFetch(ok.base, policy())).bytes.length).toBe(1024 * 1024);
});

test("S9：总时长上限（默认 20 s；此处缩小比例验证）——一直不响应、响应头后慢速滴灌，都按超时失败且标记可重试", async () => {
  expect(DEFAULT_POLICY.timeoutMs).toBe(20_000);
  const hang = await serve(() => { /* 永不响应 */ });
  const t0 = Date.now();
  const e1 = await safeFetch(hang.base, policy({}, { timeoutMs: 300 })).catch((e: AppError) => e);
  expect(e1).toBeInstanceOf(AppError);
  expect((e1 as AppError).code).toBe("fetch_timeout");
  expect((e1 as AppError).details.retryable).toBe(true);
  expect(Date.now() - t0).toBeLessThan(2000);

  const drip = await serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    const t = setInterval(() => res.write("x"), 50);
    res.on("close", () => clearInterval(t));
  });
  const t1 = Date.now();
  expect(await code(safeFetch(drip.base, policy({}, { timeoutMs: 400 })))).toBe("fetch_timeout");
  expect(Date.now() - t1).toBeLessThan(2000);
});

test("S9：重定向最多 5 次（第 6 次失败且不可重试）；总时长跨重定向累计", async () => {
  expect(DEFAULT_POLICY.maxRedirects).toBe(5);
  const chain = await serve((req, res) => {
    const n = Number(/\/r(\d+)/.exec(req.url ?? "")?.[1] ?? "0");
    const stop = Number(/stop=(\d+)/.exec(req.url ?? "")?.[1] ?? "99");
    if (n >= stop) return html(res, "<html><body>end</body></html>");
    res.writeHead(302, { location: `/r${n + 1}?stop=${stop}` });
    res.end();
  });
  const five = await safeFetch(`${chain.base}/r0?stop=5`, policy());
  expect(five.status).toBe(200);
  const six = await safeFetch(`${chain.base}/r0?stop=6`, policy()).catch((e: AppError) => e);
  expect((six as AppError).code).toBe("fetch_failed");
  expect((six as AppError).details).toMatchObject({ reason: "too_many_redirects", retryable: false });

  const slow = await serve((req, res) => {
    setTimeout(() => { res.writeHead(302, { location: req.url === "/a" ? "/b" : "/a" }); res.end(); }, 120);
  });
  expect(await code(safeFetch(`${slow.base}/a`, policy({}, { timeoutMs: 350, maxRedirects: 50 })))).toBe("fetch_timeout");
});

test("内容类型白名单；HTTP 状态的可重试判定；连接失败可重试", async () => {
  const s = await serve((req, res) => {
    const u = req.url ?? "";
    if (u === "/pdf") { res.writeHead(200, { "content-type": "application/pdf" }); return res.end("%PDF"); }
    if (u === "/none") { res.writeHead(200); return res.end("hi"); }
    if (u === "/md") { res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" }); return res.end("# t"); }
    if (u === "/xhtml") { res.writeHead(200, { "content-type": "application/xhtml+xml" }); return res.end("<html/>"); }
    const status = Number(u.slice(1));
    res.writeHead(status, { "content-type": "text/html" });
    res.end("x");
  });
  expect(await code(safeFetch(`${s.base}/pdf`, policy()))).toBe("unsupported_type");
  expect(await code(safeFetch(`${s.base}/none`, policy()))).toBe("unsupported_type");
  expect((await safeFetch(`${s.base}/md`, policy())).status).toBe(200);
  expect((await safeFetch(`${s.base}/xhtml`, policy())).status).toBe(200);
  const retry = async (status: number) => {
    const e = (await safeFetch(`${s.base}/${status}`, policy()).catch((x: AppError) => x)) as AppError;
    return [e.code, e.details.retryable, e.details.status];
  };
  expect(await retry(404)).toEqual(["fetch_failed", false, 404]);
  expect(await retry(403)).toEqual(["fetch_failed", false, 403]);
  expect(await retry(429)).toEqual(["fetch_failed", true, 429]);
  expect(await retry(503)).toEqual(["fetch_failed", true, 503]);
  const dead = await serve(() => {});
  const port = dead.port;
  await new Promise<void>((r) => { servers[servers.length - 1]!.close(() => r()); });
  const refused = (await safeFetch(`http://127.0.0.1:${port}/`, policy()).catch((x: AppError) => x)) as AppError;
  expect([refused.code, refused.details.retryable]).toEqual(["fetch_failed", true]);
});

test("端口规则：重定向到未在原 URL 中写出的非标准端口被拒绝；原 URL 显式写出的端口可用", async () => {
  const other = await serve((_req, res) => html(res));
  const a = await serve((req, res) => {
    if (req.url === "/to-other") { res.writeHead(302, { location: `http://pub.test:${other.port}/` }); return res.end(); }
    if (req.url === "/self") { res.writeHead(302, { location: "/final" }); return res.end(); }
    html(res);
  });
  const p = policy({ "pub.test": ["127.0.0.1"] });
  expect(await code(safeFetch(`http://pub.test:${a.port}/to-other`, p))).toBe("ssrf_blocked");
  expect(other.hits()).toBe(0);
  expect((await safeFetch(`http://pub.test:${a.port}/self`, p)).status).toBe(200);
});

test("请求头：User-Agent 不含邮箱；Accept-Encoding: identity（不解压，字节计数才准确）", async () => {
  let headers: IncomingMessage["headers"] = {};
  const s = await serve((req, res) => { headers = req.headers; html(res); });
  await safeFetch(s.base, policy());
  expect(headers["user-agent"]).toBe(USER_AGENT);
  expect(USER_AGENT).not.toMatch(/@|mailto/);
  expect(headers["accept-encoding"]).toBe("identity");
  expect(headers.cookie).toBeUndefined();
  expect(headers.authorization).toBeUndefined();
});

test("robots.txt：Disallow 命中 → robots_disallowed；Allow 覆盖；没有 / 取不到 robots.txt 则放行", async () => {
  const s = await serve((req, res) => {
    if (req.url === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("User-agent: *\nDisallow: /private/\nAllow: /private/ok\n"); }
    html(res);
  });
  const p = policy();
  expect(await code(assertRobotsAllows(`${s.base}/private/secret`, p))).toBe("robots_disallowed");
  expect(await code(assertRobotsAllows(`${s.base}/private/ok/page`, p))).toBe("no-error");
  expect(await code(assertRobotsAllows(`${s.base}/public/a?b=1`, p))).toBe("no-error");

  const none = await serve((req, res) => { if (req.url === "/robots.txt") { res.writeHead(404); return res.end("nope"); } html(res); });
  expect(await code(assertRobotsAllows(`${none.base}/x`, p))).toBe("no-error");
  const broken = await serve((req, res) => { if (req.url === "/robots.txt") { res.writeHead(500); return res.end(); } html(res); });
  expect(await code(assertRobotsAllows(`${broken.base}/x`, p))).toBe("no-error");
  const hang = await serve((req, res) => { if (req.url === "/robots.txt") return; html(res); });
  const t0 = Date.now();
  expect(await code(assertRobotsAllows(`${hang.base}/x`, policy({}, { timeoutMs: 300 })))).toBe("no-error");
  expect(Date.now() - t0).toBeLessThan(2000);
  // robots.txt 自身指向内网也走同一套 SSRF 检查
  expect(await code(assertRobotsAllows("http://10.0.0.1/x", policy()))).toBe("ssrf_blocked");
});
