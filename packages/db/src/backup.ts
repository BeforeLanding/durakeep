import { renameSync, rmSync, existsSync } from "node:fs";
import { fault } from "@durakeep/core";
import type { SqlDatabase } from "./sql.ts";

/**
 * 在线备份（ADR-02）：经由同一个连接队列执行 VACUUM INTO，得到 Pi 与业务同一时间点的快照。
 * 先写临时文件再改名，所以目标路径上要么没有文件，要么是完整的备份。
 */
export async function backupInto(db: SqlDatabase, targetPath: string): Promise<void> {
  if (existsSync(targetPath)) throw new Error(`备份目标已存在：${targetPath}`);
  const tmp = `${targetPath}.partial`;
  rmSync(tmp, { force: true });
  fault("backup.before_vacuum");
  await db.run("VACUUM INTO ?", tmp);
  fault("backup.after_vacuum");
  renameSync(tmp, targetPath);
}
