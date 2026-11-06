import { spawn } from "node:child_process";
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

/** 启动子进程运行一个 TS 脚本（Node 原生类型擦除），等待退出。 */
export function runChild(script: string, env: Record<string, string>, timeoutMs = 60_000): Promise<ChildExit> {
  const started = Date.now();
  const clean: NodeJS.ProcessEnv = { ...process.env, APP_MODE: "test", ...env };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: clean, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
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
}
