// T-11：R1 ×20（HTTP 层）：服务在 ingress.after_submit 被杀 → 重启（恢复扫描）→ 客户端重发同一个 client_request_id。
// 以及 ingress.after_insert：已持久化、尚未交给 Pi 时被杀，重启后由恢复扫描派发，不丢失。
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { guardDb } from "../../packages/db/src/index.ts";
import { openAppDatabase, PiRuntime, startPi, demoFaux } from "../../packages/runtime-pi/src/index.ts";
import { repoRoot } from "../support/driver.ts";

const cli = join(repoRoot, "apps/server/src/cli.ts");
const main = join(repoRoot, "apps/server/src/main.ts");
const PASSWORD = "an extremely secret passphrase";
const REPEAT = Number(process.env.REPEAT ?? 20);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `durakeep-${p}-`));

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

type Server = { base: string; proc: ChildProcess; out: () => string; exited: Promise<number | null>; stop(): Promise<void> };
async function startServer(dataDir: string, port: number, extraEnv: Record<string, string> = {}): Promise<Server> {
  const proc = spawn(process.execPath, [main], {
    env: { ...process.env, APP_MODE: "test", DATA_DIR: dataDir, PORT: String(port), ...extraEnv },
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => proc.once("exit", (code) => r(code)));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/v1/health`)).ok) break;
    } catch {
      /* 还没起来 */
    }
    if (proc.exitCode !== null) throw new Error(`服务提前退出：${out}`);
    if (Date.now() > deadline) throw new Error(`服务未就绪：${out}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    base,
    proc,
    out: () => out,
    exited,
    async stop() {
      if (proc.exitCode === null) {
        proc.kill();
        await exited;
      }
    },
  };
}

const post = (base: string, path: string, cookie: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie }, body: JSON.stringify(body) });

async function loginCookie(base: string): Promise<string> {
  const r = await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ password: PASSWORD }) });
  expect(r.status).toBe(204);
  return /sid=[^;]+/.exec(r.headers.get("set-cookie")!)![0];
}

/** 服务已停止后，在同一个数据库上用 faux 恢复并数出该会话的用户 / 助手条目。 */
async function inspect(dataDir: string, convId: string, submissionId: string) {
  const raw = await openAppDatabase(join(dataDir, "app.sqlite"));
  const db = guardDb(raw);
  const row = await db.get<{ pi_conversation_id: string }>("SELECT pi_conversation_id FROM app_conversations WHERE id = ?", convId);
  const pi = await startPi({ mode: "test", db: raw, faux: demoFaux() });
  const rt = new PiRuntime(pi, { model: { provider: "faux", modelId: "faux-1" } });
  try {
    rt.resume();
    const settled = await rt.waitSubmission(submissionId);
    let last: Parameters<Parameters<PiRuntime["observe"]>[2]>[0] | undefined;
    const obs = await rt.observe(row!.pi_conversation_id, undefined, (s) => (last = s));
    await obs.stop();
    const entries = last!.entries;
    const ingress = (await db.get<{ c: number }>("SELECT COUNT(*) AS c FROM app_ingress_events"))?.c;
    return {
      settled,
      users: entries.filter((e) => e.kind === "user").length,
      assistants: entries.filter((e) => e.kind === "assistant").length,
      ingress,
    };
  } finally {
    await rt.close();
  }
}

async function initOwner(dir: string) {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, [cli, "init", "--timezone=Asia/Shanghai"], {
      env: { ...process.env, APP_MODE: "test", DATA_DIR: dir },
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`cli init 失败：${out}`))));
    p.stdin.end(`${PASSWORD}\n`);
  });
}

test(`R1 × ${REPEAT}：Pi 已接纳、HTTP 响应丢失（服务被杀）→ 重启 → 客户端重发 → 只有一个 submission、一条用户消息`, async () => {
  const failures: string[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const dir = tmp("t11-r1");
    let s1: Server | undefined;
    let s2: Server | undefined;
    try {
      await initOwner(dir);
      const port = await freePort();
      s1 = await startServer(dir, port, { FAULT_POINT: "ingress.after_submit" });
      const cookie = await loginCookie(s1.base);
      const created = (await (await post(s1.base, "/v1/conversations", cookie, {})).json()) as { id: string };
      const crid = crypto.randomUUID();
      const sent = await post(s1.base, `/v1/conversations/${created.id}/messages`, cookie, { client_request_id: crid, text: "请回答" }).then(
        (r) => r.status,
        () => "连接断开",
      );
      const code = await s1.exited;
      if (sent !== "连接断开" || code === 0) failures.push(`#${i} 服务没有在 after_submit 被杀：sent=${sent} code=${code}`);

      s2 = await startServer(dir, port); // 恢复扫描会重新派发 accepted 的记录
      const again = await post(s2.base, `/v1/conversations/${created.id}/messages`, cookie, { client_request_id: crid, text: "请回答" });
      const body = (await again.json()) as { status: string; deduplicated: boolean; submission_id: string };
      if (again.status !== 200 || body.status !== "dispatched" || !body.deduplicated) failures.push(`#${i} 重发：${again.status} ${JSON.stringify(body)}`);
      await s2.stop();

      const r = await inspect(dir, created.id, body.submission_id);
      if (r.settled.status !== "done" || r.users !== 1 || r.assistants !== 1 || r.ingress !== 1) {
        failures.push(`#${i} 状态：${JSON.stringify({ settled: r.settled, users: r.users, assistants: r.assistants, ingress: r.ingress })}`);
      }
    } finally {
      await s1?.stop();
      await s2?.stop();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
  expect(failures).toEqual([]);
}, 900_000);

test(`ingress.after_insert × ${REPEAT}：已持久化、尚未交给 Pi 时被杀 → 重启由恢复扫描派发 → 重发得到同一结果，不丢失`, async () => {
  const failures: string[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const dir = tmp("t11-ins");
    let s1: Server | undefined;
    let s2: Server | undefined;
    try {
      await initOwner(dir);
      const port = await freePort();
      s1 = await startServer(dir, port, { FAULT_POINT: "ingress.after_insert" });
      const cookie = await loginCookie(s1.base);
      const created = (await (await post(s1.base, "/v1/conversations", cookie, {})).json()) as { id: string };
      const crid = crypto.randomUUID();
      const sent = await post(s1.base, `/v1/conversations/${created.id}/messages`, cookie, { client_request_id: crid, text: "不要丢" }).then(
        (r) => r.status,
        () => "连接断开",
      );
      await s1.exited;
      if (sent !== "连接断开") failures.push(`#${i} 没有被杀：${sent}`);

      s2 = await startServer(dir, port);
      const again = await post(s2.base, `/v1/conversations/${created.id}/messages`, cookie, { client_request_id: crid, text: "不要丢" });
      const body = (await again.json()) as { status: string; deduplicated: boolean; submission_id: string };
      // 记录是被杀之前持久化的 → 重发是 deduplicated；是否已被恢复扫描派发都应当是 dispatched
      if (again.status !== 200 || !body.deduplicated || body.status !== "dispatched") failures.push(`#${i} 重发：${again.status} ${JSON.stringify(body)}`);
      await s2.stop();
      const r = await inspect(dir, created.id, body.submission_id);
      if (r.settled.status !== "done" || r.users !== 1 || r.assistants !== 1) failures.push(`#${i} 状态：${JSON.stringify({ settled: r.settled, users: r.users, assistants: r.assistants })}`);
    } finally {
      await s1?.stop();
      await s2?.stop();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }
  expect(failures).toEqual([]);
}, 900_000);
