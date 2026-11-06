// pnpm cli init | passwd（backup / restore / export / demo 在后续任务中加入，见 06 §10）。
// 口令从终端以不回显方式读取；非 TTY（管道）时读取 stdin 的第一行，便于脚本和测试。
import { AppError, systemClock } from "@durakeep/core";
import { acquireInstanceLock, guardDb, InstanceLockedError, migrate } from "@durakeep/db";
import { openAppDatabase } from "@durakeep/runtime-pi";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { AuthService } from "./auth.ts";

// 非 TTY（管道、测试）：一次性读完 stdin，按行依次交付；TTY：readline，口令不回显。
let piped: string[] | undefined;
async function pipedLine(): Promise<string> {
  if (!piped) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    piped = Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
  }
  const line = piped.shift();
  if (line === undefined) throw new Error("输入已结束");
  return line;
}

async function ask(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  if (!process.stdin.isTTY) return pipedLine();
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const w = rl as unknown as { _writeToOutput: (s: string) => void };
  let muted = false;
  if (opts.hidden) {
    w._writeToOutput = (s) => {
      if (!muted) process.stdout.write(s);
    };
  }
  return new Promise((resolveLine, reject) => {
    rl.question(question, (answer) => {
      if (muted) process.stdout.write("\n");
      rl.close();
      resolveLine(answer);
    });
    muted = Boolean(opts.hidden);
    rl.on("close", () => reject(new Error("输入已结束")));
  });
}

async function withAuth<T>(fn: (auth: AuthService) => Promise<T>): Promise<T> {
  const dataDir = resolve(process.env.DATA_DIR ?? "data");
  mkdirSync(dataDir, { recursive: true });
  const lock = acquireInstanceLock(dataDir); // 服务正在运行时拒绝，避免两个进程同时写
  const db = await openAppDatabase(resolve(dataDir, "app.sqlite"));
  try {
    const guarded = guardDb(db);
    await migrate(guarded);
    return await fn(new AuthService(guarded, systemClock));
  } finally {
    await db.close();
    lock.release();
  }
}

async function readNewPassword(): Promise<string> {
  const p1 = await ask("口令（至少 8 个字符）：", { hidden: true });
  if (process.stdin.isTTY) {
    const p2 = await ask("再输入一次：", { hidden: true });
    if (p1 !== p2) throw new AppError("invalid_request", "两次输入的口令不一致");
  }
  return p1;
}

const [cmd] = process.argv.slice(2);
try {
  if (cmd === "init") {
    const tzArg = process.argv.find((a) => a.startsWith("--timezone="))?.slice("--timezone=".length);
    const timezone = tzArg ?? (process.stdin.isTTY ? (await ask("时区（IANA，默认 Asia/Shanghai）：")).trim() || "Asia/Shanghai" : "Asia/Shanghai");
    const password = await readNewPassword();
    await withAuth((auth) => auth.initOwner({ password, timezone }));
    console.log("已创建 owner。现在可以启动服务并登录。");
  } else if (cmd === "passwd") {
    const password = await readNewPassword();
    await withAuth((auth) => auth.changePassword(password));
    console.log("口令已修改，所有会话已失效。");
  } else {
    console.error("用法：pnpm cli <init|passwd> [--timezone=Asia/Shanghai]");
    process.exit(2);
  }
} catch (e) {
  if (e instanceof AppError) console.error(`错误（${e.code}）：${e.userMessage}`);
  else if (e instanceof InstanceLockedError) console.error(`数据目录已被进程 ${e.pid} 占用，请先停止服务。`);
  else console.error(`错误：${(e as Error).message}`);
  process.exit(1);
}
