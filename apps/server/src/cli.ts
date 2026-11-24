// 离线运维命令（06 §10）。
// 口令从终端以不回显方式读取；非 TTY（管道）时读取 stdin 的第一行，便于脚本和测试。
import { AppError, systemClock } from "@durakeep/core";
import { acquireInstanceLock, backupInto, guardDb, InstanceLockedError, migrate, type SqlDatabase } from "@durakeep/db";
import { BlobStore, KnowledgeService, readPurgeLog, replayPurgeLog } from "@durakeep/knowledge";
import { openAppDatabase } from "@durakeep/runtime-pi";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { AuthService, type Owner } from "./auth.ts";
import { backupStamp, BackupService } from "./backup.ts";
import { buildExport } from "./export.ts";
import { restoreBackup } from "./restore.ts";

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

const dataDir = resolve(process.env.DATA_DIR ?? "data");

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(dataDir, { recursive: true });
  const lock = acquireInstanceLock(dataDir); // 服务正在运行时拒绝，避免两个进程同时写
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

async function withDatabase<T>(fn: (db: SqlDatabase) => Promise<T>, create = false): Promise<T> {
  const file = join(dataDir, "app.sqlite");
  if (!create && !existsSync(file)) throw new AppError("not_found", "尚未初始化");
  const db = guardDb(await openAppDatabase(file));
  try {
    await migrate(db);
    return await fn(db);
  } finally {
    await db.close();
  }
}

async function replayPurges(db: SqlDatabase): Promise<BlobStore> {
  const blobs = new BlobStore(join(dataDir, "blobs"));
  await replayPurgeLog({ db, blobs, clock: systemClock }, readPurgeLog(join(dataDir, "purge-log.jsonl")));
  return blobs;
}

async function readNewPassword(): Promise<string> {
  const p1 = await ask("口令（至少 8 个字符）：", { hidden: true });
  if (process.stdin.isTTY) {
    const p2 = await ask("再输入一次：", { hidden: true });
    if (p1 !== p2) throw new AppError("invalid_request", "两次输入的口令不一致");
  }
  return p1;
}

const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === "init") {
    const tzArg = process.argv.find((a) => a.startsWith("--timezone="))?.slice("--timezone=".length);
    const timezone = tzArg ?? (process.stdin.isTTY ? (await ask("时区（IANA，默认 Asia/Shanghai）：")).trim() || "Asia/Shanghai" : "Asia/Shanghai");
    const password = await readNewPassword();
    await withLock(() => withDatabase((db) => new AuthService(db, systemClock).initOwner({ password, timezone }), true));
    console.log("已创建 owner。现在可以启动服务并登录。");
  } else if (cmd === "passwd") {
    const password = await readNewPassword();
    await withLock(() => withDatabase((db) => new AuthService(db, systemClock).changePassword(password)));
    console.log("口令已修改，所有会话已失效。");
  } else if (cmd === "backup") {
    const file = await withLock(() => withDatabase(async (db) => {
      await replayPurges(db);
      return new BackupService(db, systemClock, dataDir, (path) => backupInto(db, path)).create();
    }));
    console.log(file);
  } else if (cmd === "restore" && arg) {
    await withLock(async () => {
      await restoreBackup(dataDir, resolve(arg), systemClock, openAppDatabase);
      await withDatabase(replayPurges);
    });
    console.log("已恢复备份。投递已暂停，启动服务并核对后可恢复投递。");
  } else if (cmd === "export" && arg) {
    const file = await withLock(() => withDatabase(async (db) => {
      const owner = await db.get<Owner>("SELECT id, display_name AS displayName, timezone FROM app_owners LIMIT 1");
      if (!owner) throw new AppError("not_found", "尚未初始化");
      const blobs = await replayPurges(db);
      const knowledge = new KnowledgeService({ db, blobs, clock: systemClock });
      const now = systemClock.now();
      const zip = await buildExport(db, knowledge, owner, now);
      const dir = resolve(arg);
      mkdirSync(dir, { recursive: true });
      const target = join(dir, `export-${backupStamp(now)}.zip`);
      writeFileSync(target, zip, { flag: "wx" });
      return target;
    }));
    console.log(file);
  } else {
    console.error("用法：pnpm cli init [--timezone=Asia/Shanghai] | passwd | backup | restore <备份文件> | export <目录>");
    process.exit(2);
  }
} catch (e) {
  if (e instanceof AppError) console.error(`错误（${e.code}）：${e.userMessage}`);
  else if (e instanceof InstanceLockedError && cmd === "backup") {
    console.error(`数据目录已被进程 ${e.pid} 占用。服务运行时请带已登录的 sid 调用 POST http://127.0.0.1:${process.env.PORT ?? 4777}/v1/admin/backup。`);
  }
  else if (e instanceof InstanceLockedError) console.error(`数据目录已被进程 ${e.pid} 占用，请先停止服务。`);
  else console.error(`错误：${(e as Error).message}`);
  process.exit(1);
}
