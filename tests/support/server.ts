// 进程级测试的共享辅助：启动真实的服务进程、初始化 owner、登录、发请求。
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { expect } from "vitest";
import { repoRoot } from "./driver.ts";

export const cli = join(repoRoot, "apps/server/src/cli.ts");
export const main = join(repoRoot, "apps/server/src/main.ts");
export const PASSWORD = "an extremely secret passphrase";

export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export type Server = { base: string; proc: ChildProcess; out: () => string; exited: Promise<number | null>; stop(): Promise<void> };

export async function startServer(dataDir: string, port: number, extraEnv: Record<string, string> = {}): Promise<Server> {
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

export const post = (base: string, path: string, cookie: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, Cookie: cookie }, body: JSON.stringify(body) });

export const get = (base: string, path: string, cookie: string) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });

export async function loginCookie(base: string): Promise<string> {
  const r = await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ password: PASSWORD }) });
  expect(r.status).toBe(204);
  return /sid=[^;]+/.exec(r.headers.get("set-cookie")!)![0];
}

export async function initOwner(dir: string): Promise<void> {
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
