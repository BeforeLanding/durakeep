// 首次设置（网页）：数据库里还没有 owner 时，主进程先只起这个小服务，等用户在浏览器里完成设置，
// 然后关闭它、继续正常启动（各服务启动时就需要 owner_id，所以不能在完整服务里“半路”创建 owner）。
// 设置需要一次性设置码：只打印在启动服务的终端里，防止同机其他人或进程抢先占用这个实例。
import { randomInt, timingSafeEqual } from "node:crypto";
import { AppError, type Clock } from "@durakeep/core";
import type { SqlDatabase } from "@durakeep/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AuthService } from "./auth.ts";
import { setSessionCookie, type LogEvent } from "./app.ts";
import { readJson } from "./http.ts";
import { listen } from "./listen.ts";
import { staticFiles } from "./static.ts";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉易混淆的 0/O、1/I

export function newSetupCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

export type SetupDeps = { db: SqlDatabase; clock: Clock; origin: string; code: string; staticDir?: string; log?: (e: LogEvent) => void };

/** 只含首次设置所需接口的应用；onDone 在 owner 创建成功、响应发出之后调用。 */
export function createSetupApp(deps: SetupDeps, onDone: () => void) {
  const auth = new AuthService(deps.db, deps.clock);
  const app = new Hono();
  let failures = 0;
  let done = false;

  app.onError((err, c) => {
    if (err instanceof AppError) {
      const status = err.code === "unauthenticated" ? 401 : err.code === "locked" ? 423 : err.code === "origin_mismatch" ? 403 : err.code === "invalid_state" ? 409 : 400;
      return c.json({ error: { code: err.code, message: err.userMessage, details: err.details } }, status);
    }
    deps.log?.({ level: "error", event: "setup.unhandled", error: err.name });
    return c.json({ error: { code: "internal", message: "服务内部错误", details: {} } }, 500);
  });
  app.use("/v1/*", bodyLimit({ maxSize: 16 * 1024 }));
  app.use("/v1/*", async (c, next) => {
    if (c.req.method === "POST") {
      const origin = c.req.header("Origin");
      const site = c.req.header("Sec-Fetch-Site");
      if ((origin !== undefined && origin !== deps.origin) || (origin === undefined && site !== undefined && site !== "same-origin" && site !== "none")) {
        throw new AppError("origin_mismatch", "请求来源不被允许");
      }
    }
    await next();
  });

  app.get("/v1/health", (c) => c.json({ ok: true, setup_pending: !done }));
  app.get("/v1/auth/status", (c) => c.json({ initialized: done, setup_pending: !done }));
  app.post("/v1/auth/setup", async (c) => {
    if (done) throw new AppError("invalid_state", "已经完成设置，请直接登录");
    if (failures >= 10) throw new AppError("locked", "设置码错误次数过多：请重启服务获取新的设置码");
    const body = (await readJson(c)) as { setup_code?: unknown; password?: unknown; display_name?: unknown; timezone?: unknown } | null;
    const code = typeof body?.setup_code === "string" ? normalize(body.setup_code) : "";
    const expected = normalize(deps.code);
    if (code.length !== expected.length || !timingSafeEqual(Buffer.from(code), Buffer.from(expected))) {
      failures++;
      throw new AppError("unauthenticated", "设置码不正确：请查看启动服务的终端输出");
    }
    if (typeof body?.password !== "string") throw new AppError("invalid_request", "需要设置口令", { issues: [{ path: "password" }] });
    const timezone = typeof body.timezone === "string" && body.timezone !== "" ? body.timezone : "Asia/Shanghai";
    const displayName = typeof body.display_name === "string" ? body.display_name.slice(0, 40) : undefined;
    const session = await auth.setup({ password: body.password, timezone, displayName, userAgent: c.req.header("User-Agent") });
    done = true;
    setSessionCookie(c, session.token, true);
    deps.log?.({ level: "info", event: "auth.setup", owner_id: session.ownerId });
    setTimeout(onDone, 50); // 先让响应发出去
    return c.body(null, 204);
  });
  // 其他接口：服务还在等待设置
  app.all("/v1/*", (c) => c.json({ error: { code: "setup_required", message: "请先完成首次设置", details: {} } }, 503));
  if (deps.staticDir) app.use("*", staticFiles(deps.staticDir));
  return app;
}

/** 起设置服务并等待设置完成；返回时端口已释放。 */
export async function runSetupServer(deps: SetupDeps & { host: string; port: number }): Promise<void> {
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  const app = createSetupApp(deps, finish);
  const server = await listen(app.fetch, { host: deps.host, port: deps.port });
  // 中文是双宽字符，不画边框，避免终端里对不齐
  console.log(
    [
      "",
      "  ── durakeep 首次启动 ──────────────────────────",
      "  请在浏览器中打开下面的地址完成设置：",
      `    地址    http://${deps.host}:${server.port}/`,
      `    设置码  ${deps.code}`,
      "  ───────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
  await finished;
  await server.close();
}
