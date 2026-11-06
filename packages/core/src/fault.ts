// 故障注入（08 §3）。FAULT_POINT 命中第 FAULT_HIT 次时，进程自杀。
// SIGKILL 的 Windows 行为（TerminateProcess，不执行退出钩子）见 docs/spikes/P0-REPORT.md。
export type FaultPoint = string;

const hits = new Map<string, number>();

export function fault(point: FaultPoint, env: NodeJS.ProcessEnv = process.env): void {
  if (env.FAULT_POINT !== point) return;
  const n = Number(env.FAULT_HIT ?? "1");
  const count = (hits.get(point) ?? 0) + 1;
  hits.set(point, count);
  if (count === n) process.kill(process.pid, "SIGKILL");
}

export function resetFaultHits(): void {
  hits.clear();
}
