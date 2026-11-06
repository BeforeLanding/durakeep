import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { acquireInstanceLock, InstanceLockedError } from "./instanceLock.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "durakeep-lock-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("获取后写入 pid，释放后文件消失", () => {
  const dir = tmp();
  const lock = acquireInstanceLock(dir);
  expect(readFileSync(lock.path, "utf8")).toBe(String(process.pid));
  lock.release();
  expect(existsSync(lock.path)).toBe(false);
  lock.release(); // 幂等
});

test("持有者进程仍存活 → InstanceLockedError，且不破坏对方的锁文件", () => {
  const dir = tmp();
  const lockPath = join(dir, "app.lock");
  writeFileSync(lockPath, String(process.ppid)); // 父进程（vitest）必然存活
  expect(() => acquireInstanceLock(dir)).toThrow(InstanceLockedError);
  expect(readFileSync(lockPath, "utf8")).toBe(String(process.ppid));
});

test("持有者已死（崩溃遗留）→ 接管；内容损坏也接管", () => {
  const dir = tmp();
  writeFileSync(join(dir, "app.lock"), "2147483646"); // 不存在的 pid
  const lock = acquireInstanceLock(dir);
  expect(readFileSync(lock.path, "utf8")).toBe(String(process.pid));
  lock.release();
  writeFileSync(join(dir, "app.lock"), "not-a-pid");
  acquireInstanceLock(dir).release();
});

test("release 不删除已被别的进程接管的锁", () => {
  const dir = tmp();
  const lock = acquireInstanceLock(dir);
  writeFileSync(lock.path, String(process.ppid));
  lock.release();
  expect(readFileSync(lock.path, "utf8")).toBe(String(process.ppid));
});
