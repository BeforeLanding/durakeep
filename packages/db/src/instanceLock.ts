import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

export class InstanceLockedError extends Error {
  readonly code = "instance_locked";
  readonly pid: number;
  readonly lockPath: string;
  constructor(pid: number, lockPath: string) {
    super(`数据目录已被进程 ${pid} 占用（${lockPath}）`);
    this.name = "InstanceLockedError";
    this.pid = pid;
    this.lockPath = lockPath;
  }
}

export type InstanceLock = { readonly path: string; release(): void };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0); // 信号 0：只探测进程是否存在
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // 存在但无权限
  }
}

/**
 * 数据目录实例锁（R16）：独占创建 app.lock 并写入 pid。
 * 已存在时探测持有者：进程还活着 → 抛 InstanceLockedError；已死（崩溃遗留）→ 接管。
 * 局限：不防 pid 被复用；两个进程同时接管陈旧锁时，unlink 后的 wx 创建只有一个能成功，另一个会拿到 InstanceLockedError。
 */
export function acquireInstanceLock(dataDir: string): InstanceLock {
  const path = join(dataDir, "app.lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      return {
        path,
        release() {
          if (released) return;
          released = true;
          try {
            if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
          } catch {
            /* 已被移除 */
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = Number.parseInt(readFileSyncSafe(path), 10);
      if (Number.isInteger(holder) && holder !== process.pid && alive(holder)) throw new InstanceLockedError(holder, path);
      try {
        unlinkSync(path); // 陈旧锁：持有者已死（或内容损坏）
      } catch {
        /* 被别人先清掉了，重试 */
      }
    }
  }
  throw new Error(`无法获取实例锁：${path}`);
}

function readFileSyncSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
