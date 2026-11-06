// T-05：R8、R15、R16、K3，每个用例重复 20 次（08 §4）。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { repoRoot, runChild, spawnChild } from "../support/driver.ts";

const script = join(repoRoot, "packages/runtime-pi/src/testing/child-p0.ts");
const REPEAT = Number(process.env.REPEAT ?? 20);
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `durakeep-${p}-`));
type Summary = { status: string; kinds: string[]; toolResults: string[]; probeRows: number; callCount: number; reports: string[]; integrity?: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test(`R8 × ${REPEAT}：存储写入失败 → Harness 失效、进程退出；重启后已接纳的输入仍在，run 完成`, async () => {
  const failures: string[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const dir = tmp("r8");
    try {
      const first = await runChild(script, { DATA_DIR: dir, SCENARIO: "r8-first" });
      const fatal = existsSync(join(dir, "fatal.log")) ? readFileSync(join(dir, "fatal.log"), "utf8").trim() : "";
      if (first.code !== 3 || fatal === "") failures.push(`#${i} 第一次：code=${first.code} fatal=${fatal} out=${first.stdout.slice(0, 200)} err=${first.stderr.slice(0, 200)}`);
      // 第一个进程已死，留下陈旧锁：第二个进程应当接管
      const second = await runChild(script, { DATA_DIR: dir, SCENARIO: "r8-second" });
      const s = second.result as Summary | undefined;
      if (!s || s.status !== "done" || !s.kinds.includes("pi.user") || s.callCount !== 1) failures.push(`#${i} 第二次：${JSON.stringify(s)} err=${second.stderr.slice(0, 300)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  expect(failures).toEqual([]);
}, 600_000);

test(`R15 × ${REPEAT}：每次启动都在同一个工具里崩溃 → 重启 5 次（restartLimit 默认值）后，工具调用以 restart_limit 错误结果结束，run 完成，不陷入无限重启`, async () => {
  const failures: string[] = [];
  const restartsSeen: number[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const dir = tmp("r15");
    try {
      let restarts = 0;
      let final: Summary | undefined;
      for (let n = 0; n < 15; n++) {
        const r = await runChild(script, {
          DATA_DIR: dir,
          SCENARIO: n === 0 ? "r15-first" : "r15-next",
          FAULT_POINT: "tool.in_execute",
          FAULT_HIT: "1",
        });
        if (r.result !== undefined) {
          final = r.result as Summary;
          break;
        }
        restarts++;
      }
      restartsSeen.push(restarts);
      const text = (final?.toolResults ?? []).join("|"); // 模型可见的错误文本；restart_limit 在 diagnostics 中
      if (!final || final.status !== "done" || !/interrupted 5 times in a row; it is not run again/.test(text) || !final.reports.includes("task_interrupted") || restarts !== 5) failures.push(`#${i} restarts=${restarts} final=${JSON.stringify(final)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(`[R15] 每轮崩溃次数（直到工具调用以 restart_limit 结束）：${JSON.stringify(restartsSeen)}`);
  expect(failures).toEqual([]);
  expect(Math.max(...restartsSeen)).toBeLessThanOrEqual(10);
}, 900_000);

test(`R16 × ${REPEAT}：第二个进程打开同一数据目录被实例锁拒绝；第一个进程不受影响`, async () => {
  const failures: string[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const dir = tmp("r16");
    try {
      const holder = spawnChild(script, { DATA_DIR: dir, SCENARIO: "r16-hold" });
      const deadline = Date.now() + 20_000;
      while (!existsSync(join(dir, "holder-ready"))) {
        if (Date.now() > deadline) throw new Error("holder 未就绪");
        await sleep(10);
      }
      const intruder = await runChild(script, { DATA_DIR: dir, SCENARIO: "r16-hold" });
      const r = intruder.result as { locked?: boolean } | undefined;
      if (intruder.code !== 5 || r?.locked !== true) failures.push(`#${i} 闯入者：code=${intruder.code} ${intruder.stdout.slice(0, 200)}`);
      writeFileSync(join(dir, "holder-release"), "1");
      const h = await holder.exited;
      const s = h.result as Summary | undefined;
      if (h.code !== 0 || s?.status !== "done") failures.push(`#${i} 持有者受影响：code=${h.code} ${JSON.stringify(s)} ${h.stderr.slice(0, 200)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  expect(failures).toEqual([]);
}, 600_000);

test(`K3 × ${REPEAT}：run 进行中执行 VACUUM INTO；用副本启动后未完成的 run 恢复`, async () => {
  const failures: string[] = [];
  for (let i = 0; i < REPEAT; i++) {
    const dir = tmp("k3");
    const copy = tmp("k3copy");
    try {
      const first = await runChild(script, { DATA_DIR: dir, SCENARIO: "k3-first", WAIT_BACKUP: "1", BACKUP_DIR: copy });
      const a = first.result as Summary | undefined;
      if (first.code !== 0 || a?.status !== "done") failures.push(`#${i} 原库：${JSON.stringify(a)} ${first.stderr.slice(0, 300)}`);
      if (!existsSync(join(copy, "app.sqlite")) || existsSync(join(copy, "app.sqlite.partial"))) failures.push(`#${i} 备份文件状态不对`);
      const second = await runChild(script, { DATA_DIR: copy, SCENARIO: "k3-copy" });
      const b = second.result as Summary | undefined;
      // 副本：快照时工具已执行并写了业务行、但 run 未完成；恢复后 run 完成，业务行仍是 1 行，模型只被请求最后 1 次
      if (!b || b.status !== "done" || b.integrity !== "ok" || b.probeRows !== 1 || b.callCount !== 1 || !b.kinds.includes("pi.tool-result")) failures.push(`#${i} 副本：${JSON.stringify(b)} ${second.stderr.slice(0, 300)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(copy, { recursive: true, force: true });
    }
  }
  expect(failures).toEqual([]);
}, 600_000);
