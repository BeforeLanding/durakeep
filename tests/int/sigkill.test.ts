import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { repoRoot, runChild } from "../support/driver.ts";

const script = join(repoRoot, "tests/support/sigkill-child.ts");

test("外部 process.kill(pid, SIGKILL)：立即终止，不执行任何退出钩子", async () => {
  const dir = mkdtempSync(join(tmpdir(), "durakeep-kill-"));
  try {
    const child = spawn(process.execPath, [script], { env: { ...process.env, DATA_DIR: dir }, stdio: "ignore" });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>((res) =>
      child.on("exit", (code, signal) => res({ code, signal, at: Date.now() })),
    );
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(dir, "ticks.log"))) {
      if (Date.now() > deadline) throw new Error("子进程未就绪");
      await new Promise((r) => setTimeout(r, 10));
    }
    const t0 = Date.now();
    process.kill(child.pid!, "SIGKILL");
    const end = await exited;
    const latency = end.at - t0;
    console.log(`[sigkill 外部] code=${end.code} signal=${end.signal} latency=${latency}ms`);
    expect(latency).toBeLessThan(1000);
    expect(existsSync(join(dir, "hooks.log"))).toBe(false);
    // 杀掉之后不再有新的 tick
    const ticks = readFileSync(join(dir, "ticks.log"), "utf8");
    await new Promise((r) => setTimeout(r, 100));
    expect(readFileSync(join(dir, "ticks.log"), "utf8")).toBe(ticks);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("自杀 process.kill(process.pid, SIGKILL)：之后的语句不再执行，钩子不执行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "durakeep-kill-"));
  try {
    const r = await runChild(script, { DATA_DIR: dir, SELF_KILL: "1" });
    console.log(`[sigkill 自杀] code=${r.code} signal=${r.signal} ms=${r.ms}`);
    const ticks = readFileSync(join(dir, "ticks.log"), "utf8");
    expect(ticks).toContain("before-self-kill");
    expect(ticks).not.toContain("AFTER-SELF-KILL");
    expect(existsSync(join(dir, "hooks.log"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
