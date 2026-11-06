// pnpm cli init + 真实服务进程：init → 启动 → 登录 → 健康检查；服务运行时 cli 被实例锁拒绝；口令不出现在输出里。
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { repoRoot } from "../support/driver.ts";

const cli = join(repoRoot, "apps/server/src/cli.ts");
const main = join(repoRoot, "apps/server/src/main.ts");
const PASSWORD = "an extremely secret passphrase";
const dirs: string[] = [];
const procs: ChildProcess[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) {
    if (p.exitCode === null) {
      const exited = new Promise((r) => p.once("exit", r));
      p.kill();
      await exited; // Windows 上进程退出前数据库文件仍被占用
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function run(script: string, args: string[], env: Record<string, string>, stdin?: string) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, APP_MODE: "test", ...env },
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
    child.stdin.end(stdin ?? "");
  });
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("cli init → 启动服务 → 登录 → 健康；服务运行时 cli 被拒；重复 init 被拒", async () => {
  const dir = mkdtempSync(join(tmpdir(), "durakeep-cli-"));
  dirs.push(dir);
  const env = { DATA_DIR: dir };

  const short = await run(cli, ["init"], env, "short\n");
  expect(short.code).toBe(1);
  expect(short.out).toContain("invalid_request");

  const init = await run(cli, ["init", "--timezone=Asia/Shanghai"], env, `${PASSWORD}\n`);
  expect(init.code, init.out).toBe(0);
  expect(init.out).not.toContain(PASSWORD);

  const again = await run(cli, ["init"], env, `${PASSWORD}\n`);
  expect(again.code).toBe(1);
  expect(again.out).toContain("已存在");

  const port = await freePort();
  const server = spawn(process.execPath, [main], {
    env: { ...process.env, APP_MODE: "test", ...env, PORT: String(port) },
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(server);
  let serverOut = "";
  server.stdout.on("data", (d) => (serverOut += d));
  server.stderr.on("data", (d) => (serverOut += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/v1/health`)).ok) break;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error(`服务未就绪：${serverOut}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  const login = await fetch(`${base}/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ password: PASSWORD }),
  });
  expect(login.status).toBe(204);
  const cookie = /sid=[^;]+/.exec(login.headers.get("set-cookie")!)![0];
  const me = await fetch(`${base}/v1/me`, { headers: { Cookie: cookie } });
  expect(await me.json()).toMatchObject({ timezone: "Asia/Shanghai" });
  expect((await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { Origin: "http://evil.example" }, body: "{}" })).status).toBe(403);

  // 服务运行中：cli 修改口令被实例锁拒绝
  const locked = await run(cli, ["passwd"], env, "another long passphrase\n");
  expect(locked.code).toBe(1);
  expect(locked.out).toContain("已被进程");

  // 日志里没有口令、cookie
  expect(serverOut).not.toContain(PASSWORD);
  expect(serverOut).not.toContain(cookie.slice(4));
  expect(serverOut).toContain('"event":"listening"');
});
