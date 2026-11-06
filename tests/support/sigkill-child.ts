// 注册各种退出钩子；若 SIGKILL 语义正确，这些钩子都不会执行。
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.DATA_DIR!;
const mark = (s: string) => appendFileSync(join(dir, "hooks.log"), `${s}\n`);
process.on("exit", () => mark("exit"));
process.on("beforeExit", () => mark("beforeExit"));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"] as const) process.on(sig, () => mark(sig));
// 在“持久写入窗口”内：先写一行，再自杀前不应有后续行
writeFileSync(join(dir, "ready"), String(process.pid));
const t = setInterval(() => appendFileSync(join(dir, "ticks.log"), `${Date.now()}\n`), 5);
void t;
if (process.env.SELF_KILL === "1") {
  appendFileSync(join(dir, "ticks.log"), "before-self-kill\n");
  process.kill(process.pid, "SIGKILL");
  // 若 kill 不是立即生效，下面这行会写出
  appendFileSync(join(dir, "ticks.log"), "AFTER-SELF-KILL\n");
}
