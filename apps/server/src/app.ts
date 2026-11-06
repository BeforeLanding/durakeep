import { AppError, type Clock, type ErrorCode } from "@durakeep/core";
import type { ConversationService, IngressService } from "@durakeep/conversations";
import type { ConversationSnapshot, RuntimePort } from "@durakeep/core";
import type { SqlDatabase } from "@durakeep/db";
import type { KnowledgeService } from "@durakeep/knowledge";
import { Hono, type MiddlewareHandler } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { AuthService, SESSION_TTL_MS, type Owner } from "./auth.ts";
import { EventHub } from "./hub.ts";
import { readJson } from "./http.ts";
import { presentEntry, presentSnapshot } from "./present.ts";
import { mountDocumentRoutes } from "./routes-documents.ts";
import { RateLimiter } from "./rateLimit.ts";
import { latestThrottle } from "./throttle.ts";

// 06 §1 的错误码 → HTTP 状态
const STATUS: Record<ErrorCode, 400 | 401 | 403 | 404 | 409 | 413 | 422 | 423 | 429 | 500 | 502 | 503 | 504> = {
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
  robots_disallowed: 422,
  fetch_failed: 502,
  fetch_timeout: 504,
  extract_failed: 422,
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
  /** 会话与入口（T-11）；未提供时不挂载 /v1/conversations。 */
  chat?: { conversations: ConversationService; ingress: IngressService; runtime: RuntimePort };
  /** 全局事件中心（06 §9.2）；缺省时由 createApp 新建。 */
  hub?: EventHub;
  /** 资料与作业（T-13）；未提供时不挂载 /v1/documents、/v1/jobs。 */
  knowledge?: KnowledgeService;
  /** 入队 / 重试后唤醒 JobWorker。 */
  wakeJobs?: () => void;
  /** SSE 参数：快照节流（默认 100 ms）、keep-alive 间隔（默认 15 s）。 */
  sse?: { throttleMs?: number; keepAliveMs?: number };
  /** 覆盖默认限流（每分钟次数），测试用。 */
  limits?: Partial<Record<keyof typeof LIMITS, number>>;
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

  const tooLarge = () => {
    throw new AppError("too_large", "请求体过大");
  };
  const smallBody = bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge });
  const captureBody = bodyLimit({ maxSize: 3 * 1024 * 1024, onError: tooLarge }); // 50 万字符 ≈ 1.5 MB，上传 ≤2 MB
  app.use("*", (c, next) => (c.req.method === "POST" && c.req.path === "/v1/documents" ? captureBody(c, next) : smallBody(c, next)));

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
    const wait = limiter.hit("login", deps.limits?.login ?? LIMITS.login);
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

  const hub = deps.hub ?? new EventHub();
  if (deps.chat) mountConversationRoutes(app, deps, deps.chat, limiter);
  if (deps.knowledge) mountDocumentRoutes(app, { db: deps.db, clock: deps.clock, limits: deps.limits, wake: deps.wakeJobs }, deps.knowledge, limiter, LIMITS.capture);
  mountGlobalStream(app, deps, hub);

  return { app, auth, limiter, hub };
}

function mountConversationRoutes(
  app: Hono<AppEnv>,
  deps: AppDeps,
  chat: NonNullable<AppDeps["chat"]>,
  limiter: RateLimiter,
) {
  const limits = deps.limits;
  const { conversations, ingress, runtime } = chat;
  const throttleMs = deps.sse?.throttleMs ?? 100;
  const keepAliveMs = deps.sse?.keepAliveMs ?? 15_000;
  const present = (c: { id: string; title: string; createdAt: number; lastActiveAt: number; archived: boolean }) => ({
    id: c.id,
    title: c.title,
    created_at: c.createdAt,
    last_active_at: c.lastActiveAt,
    archived: c.archived,
  });

  app.get("/v1/conversations", async (c) => {
    const limit = c.req.query("limit");
    const n = limit === undefined ? undefined : Number(limit);
    if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 100)) {
      throw new AppError("invalid_request", "limit 需为 1–100 的整数", { issues: [{ path: "limit" }] });
    }
    const page = await conversations.list(c.get("owner").id, { limit: n, cursor: c.req.query("cursor") });
    return c.json({ items: page.items.map(present), next_cursor: page.nextCursor });
  });

  app.post("/v1/conversations", async (c) => {
    const body = (await readJson(c, true)) as { title?: unknown } | null;
    const created = await conversations.create(c.get("owner").id, body?.title as string | undefined);
    return c.json(present(created), 201);
  });

  app.patch("/v1/conversations/:id", async (c) => {
    const body = (await readJson(c)) as { title?: unknown; archived?: unknown } | null;
    const updated = await conversations.update(c.get("owner").id, c.req.param("id"), body ?? {});
    return c.json(present(updated));
  });

  app.post("/v1/conversations/:id/messages", async (c) => {
    const owner = c.get("owner");
    const wait = limiter.hit(`msg:${owner.id}`, limits?.message ?? LIMITS.message);
    if (wait !== undefined) throw new AppError("rate_limited", "发送过于频繁", { retry_after_ms: wait });
    const body = (await readJson(c)) as { client_request_id?: unknown; text?: unknown; steer?: unknown } | null;
    const r = await ingress.accept(owner, c.req.param("id"), {
      clientRequestId: body?.client_request_id,
      text: body?.text,
      steer: body?.steer,
    });
    return c.json(
      { ingress_id: r.ingressId, submission_id: r.submissionId, status: r.status, deduplicated: r.deduplicated },
      r.deduplicated ? 200 : 202,
    );
  });

  // 加载更早的条目（06 §3）：before 不含；缺省从最新开始
  app.get("/v1/conversations/:id/entries", async (c) => {
    const conv = await conversations.get(c.get("owner").id, c.req.param("id"));
    const before = c.req.query("before");
    if (before !== undefined && !/^\d+$/.test(before)) {
      throw new AppError("invalid_request", "before 必须是条目 ID", { issues: [{ path: "before" }] });
    }
    const limitQ = c.req.query("limit");
    const limit = limitQ === undefined ? 50 : Number(limitQ);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new AppError("invalid_request", "limit 需为 1–100 的整数", { issues: [{ path: "limit" }] });
    }
    const page = await runtime.loadEarlier(conv.piConversationId, before, limit);
    return c.json({ entries: page.entries.map(presentEntry), has_earlier: page.hasEarlier });
  });

  // 会话流（06 §9.1）：每次提交推送一次完整快照，100 ms 节流；Last-Event-ID 续传
  app.get("/v1/conversations/:id/stream", async (c) => {
    const conv = await conversations.get(c.get("owner").id, c.req.param("id")); // 不属于自己 → 404，不开流
    const lastId = c.req.header("Last-Event-ID");
    const from = lastId !== undefined && /^\d+$/.test(lastId) ? lastId : undefined; // 无效游标 → 最新窗口
    return streamSSE(c, async (stream) => {
      let observer: Awaited<ReturnType<RuntimePort["observe"]>> | undefined;
      let chain: Promise<void> = Promise.resolve();
      const throttle = latestThrottle<ConversationSnapshot>(deps.clock, throttleMs, (snap) => {
        chain = chain.then(() =>
          stream
            .writeSSE({ event: "snapshot", ...(snap.cursor !== undefined ? { id: snap.cursor } : {}), data: JSON.stringify(presentSnapshot(snap)) })
            .catch(() => {}),
        );
      });
      try {
        observer = await runtime.observe(conv.piConversationId, from, (s) => throttle.push(s));
        await holdOpen(stream, deps.clock, keepAliveMs);
      } finally {
        throttle.close();
        await observer?.stop();
      }
    });
  });

  app.post("/v1/conversations/:id/continue", async (c) => {
    const r = await ingress.continue(c.get("owner").id, c.req.param("id"));
    return c.json({ submission_id: r.submissionId }, 202);
  });

  app.post("/v1/conversations/:id/abort", async (c) => {
    return c.json(await ingress.abort(c.get("owner").id, c.req.param("id")));
  });
}

/** 保持连接直到客户端断开，期间每 keepAliveMs 发一次注释行。 */
function holdOpen(stream: SSEStreamingApi, clock: Clock, keepAliveMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let cancel: (() => void) | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      cancel?.();
      resolve();
    };
    const tick = () => {
      if (done) return;
      stream.write(": keep-alive\n\n").then(
        () => {
          if (!done) cancel = clock.setTimer(tick, keepAliveMs);
        },
        finish,
      );
    };
    stream.onAbort(finish);
    cancel = clock.setTimer(tick, keepAliveMs);
  });
}

/** 全局流（06 §9.2）：runtime / notification / job / unread，按 owner 过滤。 */
function mountGlobalStream(app: Hono<AppEnv>, deps: AppDeps, hub: EventHub) {
  const keepAliveMs = deps.sse?.keepAliveMs ?? 15_000;
  app.get("/v1/stream", (c) => {
    const owner = c.get("owner");
    return streamSSE(c, async (stream) => {
      let chain: Promise<void> = Promise.resolve();
      const send = (event: string, data: unknown) => {
        chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {}));
      };
      send("runtime", { status: deps.isHealthy && !deps.isHealthy() ? "failed" : "ok" });
      const unsubscribe = hub.subscribe((e) => {
        if (e.ownerId === "*" || e.ownerId === owner.id) send(e.event, e.data);
      });
      try {
        await holdOpen(stream, deps.clock, keepAliveMs);
      } finally {
        unsubscribe();
      }
    });
  });
}
