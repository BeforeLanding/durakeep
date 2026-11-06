import { AppError, type Clock, type ErrorCode } from "@durakeep/core";
import type { SqlDatabase } from "@durakeep/db";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { AuthService, SESSION_TTL_MS, type Owner } from "./auth.ts";
import { RateLimiter } from "./rateLimit.ts";

// 06 §1 的错误码 → HTTP 状态
const STATUS: Record<ErrorCode, 400 | 401 | 403 | 404 | 409 | 413 | 422 | 423 | 429 | 500 | 503> = {
  invalid_request: 400,
  unauthenticated: 401,
  origin_mismatch: 403,
  not_found: 404,
  idempotency_conflict: 409,
  conversation_busy: 409,
  revision_conflict: 409,
  too_large: 413,
  ssrf_blocked: 422,
  unsupported_type: 422,
  time_in_past: 422,
  locked: 423,
  rate_limited: 429,
  runtime_unavailable: 503,
  delivery_paused: 503,
  internal: 500,
};

export type LogEvent = { level: "info" | "warn" | "error"; event: string; [k: string]: string | number | boolean | undefined };

export type AppDeps = {
  db: SqlDatabase;
  clock: Clock;
  /** 服务自身的 origin，如 http://127.0.0.1:4777；修改类请求的 Origin 必须与之相等。 */
  origin: string;
  /** /v1/health：运行时失效或恢复中时返回 false → 503。 */
  isHealthy?: () => boolean;
  /** 日志只记 ID 与状态（AGENTS.md 硬规则 9）。 */
  log?: (e: LogEvent) => void;
};

export type AppEnv = { Variables: { owner: Owner } };

export const LIMITS = { login: 10, message: 30, capture: 20 } as const; // 每分钟

export function createApp(deps: AppDeps) {
  const auth = new AuthService(deps.db, deps.clock);
  const limiter = new RateLimiter(deps.clock);
  const log = deps.log ?? (() => {});
  const app = new Hono<AppEnv>();

  const errorBody = (code: ErrorCode, message: string, details: Record<string, unknown> = {}) => ({
    error: { code, message, details },
  });

  app.onError((err, c) => {
    if (err instanceof AppError) {
      const status = STATUS[err.code];
      const retry = err.details.retry_after_ms;
      if (typeof retry === "number") c.header("Retry-After", String(Math.ceil(retry / 1000)));
      return c.json(errorBody(err.code, err.userMessage, err.details), status);
    }
    // 其他异常：不向客户端泄露细节，日志只记错误名
    log({ level: "error", event: "http.unhandled", path: c.req.path, error: err.name });
    return c.json(errorBody("internal", "服务内部错误"), 500);
  });
  app.notFound((c) => c.json(errorBody("not_found", "资源不存在"), 404));

  // 请求日志：方法、路径、状态、耗时；不记录 body、cookie 或查询串
  app.use("*", async (c, next) => {
    const t0 = deps.clock.now();
    await next();
    log({ level: "info", event: "http", method: c.req.method, path: c.req.path, status: c.res.status, ms: deps.clock.now() - t0 });
  });

  app.use("*", bodyLimit({ maxSize: 1024 * 1024, onError: () => { throw new AppError("too_large", "请求体过大"); } }));

  // FR-AUTH-03 / S4：修改类请求检查来源
  const originGuard: MiddlewareHandler = async (c, next) => {
    if (c.req.method === "POST" || c.req.method === "PATCH" || c.req.method === "DELETE") {
      const origin = c.req.header("Origin");
      if (origin !== undefined) {
        if (origin !== deps.origin) throw new AppError("origin_mismatch", "请求来源不被允许");
      } else {
        // 没有 Origin：非浏览器客户端（curl、CLI）放行；浏览器会带 Sec-Fetch-Site，跨站则拒绝
        const site = c.req.header("Sec-Fetch-Site");
        if (site !== undefined && site !== "same-origin" && site !== "none") {
          throw new AppError("origin_mismatch", "请求来源不被允许");
        }
      }
    }
    await next();
  };
  app.use("/v1/*", originGuard);

  // 认证：除 login 与 health 外都要求有效的 sid
  const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
    const owner = await auth.authenticate(getCookie(c, "sid"));
    if (!owner) throw new AppError("unauthenticated", "请先登录");
    c.set("owner", owner);
    await next();
  };
  app.use("/v1/*", async (c, next) => {
    if (c.req.path === "/v1/auth/login" || c.req.path === "/v1/health") return next();
    return requireAuth(c, next);
  });

  app.get("/v1/health", (c) => {
    if (deps.isHealthy && !deps.isHealthy()) return c.json(errorBody("runtime_unavailable", "运行时不可用"), 503);
    return c.json({ ok: true });
  });

  app.post("/v1/auth/login", async (c) => {
    const wait = limiter.hit("login", LIMITS.login);
    if (wait !== undefined) throw new AppError("rate_limited", "请求过于频繁", { retry_after_ms: wait });
    const body = await readJson(c);
    const password = (body as { password?: unknown } | null)?.password;
    if (typeof password !== "string" || password.length === 0 || password.length > 256) {
      throw new AppError("invalid_request", "参数无效", { issues: [{ path: "password", message: "需要非空字符串（≤256）" }] });
    }
    const session = await auth.login(password);
    setCookie(c, "sid", session.token, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    log({ level: "info", event: "auth.login", owner_id: session.ownerId });
    return c.body(null, 204);
  });

  app.post("/v1/auth/logout", async (c) => {
    await auth.logout(getCookie(c, "sid"));
    deleteCookie(c, "sid", { path: "/" });
    log({ level: "info", event: "auth.logout", owner_id: c.get("owner").id });
    return c.body(null, 204);
  });

  app.get("/v1/me", (c) => {
    const o = c.get("owner");
    return c.json({ owner_id: o.id, display_name: o.displayName, timezone: o.timezone });
  });

  return { app, auth, limiter };
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError("invalid_request", "请求体不是有效的 JSON");
  }
}
