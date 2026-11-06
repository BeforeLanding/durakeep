import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  result?: unknown;
  ms: number;
};

export type RunningChild = { child: ChildProcess; exited: Promise<ChildExit> };

/** 启动子进程运行一个 TS 脚本（Node 原生类型擦除），不等待退出。 */
export function spawnChild(script: string, env: Record<string, string>, timeoutMs = 60_000): RunningChild {
  const started = Date.now();
  const clean: NodeJS.ProcessEnv = { ...process.env, APP_MODE: "test", ...env };
  const child = spawn(process.execPath, [script], { env: clean, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d) => (stdout += d));
  child.stderr!.on("data", (d) => (stderr += d));
  const exited = new Promise<ChildExit>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`子进程超时：${script}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
      resolve({ code, signal, stdout, stderr, ms: Date.now() - started, result: line ? JSON.parse(line.slice(7)) : undefined });
    });
  });
  return { child, exited };
}

/** 启动子进程并等待退出。 */
export function runChild(script: string, env: Record<string, string>, timeoutMs = 60_000): Promise<ChildExit> {
  return spawnChild(script, env, timeoutMs).exited;
}
