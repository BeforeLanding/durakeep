import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { repoRoot } from "./driver.ts";

/** 模拟一个没有模型凭据的全新本机安装。 */
export async function startDemo() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => listener.close((err) => err ? reject(err) : resolve()));
  const dir = await mkdtemp(join(tmpdir(), "durakeep-demo-test-"));
  const env: NodeJS.ProcessEnv = { APP_MODE: "demo", DATA_DIR: dir, PORT: String(port) };
  for (const name of Object.keys(process.env)) {
    if (!/_API_KEY$/i.test(name) && !Object.hasOwn(env, name)) env[name] = process.env[name];
  }
  // 防止宿主的故障注入选项改变冒烟流程。
  delete env.FAULT_POINT;
  delete env.FAULT_HIT;
  const proc = spawn(process.execPath, [join(repoRoot, "apps/server/src/demo.ts")], {
    env, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let closed = false;
  const exited = new Promise<void>((resolve) => proc.once("close", () => { closed = true; resolve(); }));
  proc.on("error", (e) => { output += e.name + "\n"; });
  proc.stdout.setEncoding("utf8").on("data", (data: string) => { output += data; });
  proc.stderr.setEncoding("utf8").on("data", (data: string) => { output += data; });
  const stop = async () => {
    if (!closed) proc.kill("SIGKILL");
    await exited;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  const url = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 20_000;
    while (!closed && Date.now() < deadline) {
      const ready = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(1_000) }).then((r) => r.ok, () => false);
      if (ready && output.includes(`演示地址：${url}/`)) return { url, stop, output: () => output };
      await delay(30);
    }
    throw new Error(`演示服务未启动\n${output}`);
  } catch (e) {
    await stop();
    throw e;
  }
}
