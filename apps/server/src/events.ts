import { AppError, uuidv7, type Clock } from "@durakeep/core";
import type { SqlDatabase, SqlExecutor } from "@durakeep/db";
import type { PiDiagnostic } from "@durakeep/runtime-pi";
import { appendFileSync, readFileSync, rmSync } from "node:fs";

type Level = "info" | "warn" | "error";
type Refs = Record<string, string | number>;
type Row = { id: string; level: Level; kind: string; ref_json: string; message: string; created_at: number };
const OWNER = "json_extract(ref_json, '$.owner_id') = ?";
const PI_REPORTS = {
  storage_failed: ["pi.storage_failed", "error"],
  task_faulted: ["pi.task_faulted", "warn"],
  task_interrupted: ["pi.task_faulted", "warn"],
  migration_failed: ["pi.task_blocked", "error"],
  task_outdated: ["pi.task_blocked", "error"],
  extension_error: ["pi.extension_error", "warn"],
  task_error: ["pi.extension_error", "warn"],
  host_error: ["pi.extension_error", "warn"],
  listener_error: ["pi.extension_error", "warn"],
} as const satisfies Record<PiDiagnostic["report_kind"], readonly [string, Level]>;
const LEVELS = new Set<string>(["info", "warn", "error"]);
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export class EventStore {
  readonly #db: SqlDatabase;
  readonly #clock: Clock;
  constructor(db: SqlDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  async record(ownerId: string, kind: string, level: Level, refs: Refs = {}, state = kind): Promise<void> {
    await insert(this.#db, ownerId, this.#clock.now(), kind, level, refs, state);
  }

  async recordPi(ownerId: string, report: PiDiagnostic): Promise<void> {
    const [kind, level] = PI_REPORTS[report.report_kind];
    await this.record(ownerId, kind, level, report, report.reason ?? report.report_kind);
  }

  async profileTruncated(ownerId: string, revision: number): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const existing = await tx.get(
        `SELECT 1 FROM app_events WHERE ${OWNER} AND kind = 'profile.truncated' AND json_extract(ref_json, '$.revision') = ?`,
        ownerId, revision,
      );
      if (!existing) await insert(tx, ownerId, this.#clock.now(), "profile.truncated", "warn", { revision }, "truncated");
    });
  }

  async list(ownerId: string, filters: { level?: string; cursor?: string; limit: number }) {
    const { level, cursor, limit } = filters;
    if (level !== undefined && !LEVELS.has(level)) {
      throw new AppError("invalid_request", "level 需为 info、warn 或 error", { issues: [{ path: "level" }] });
    }
    const before = cursor === undefined ? undefined : decodeCursor(cursor);
    const rows = await this.#db.all<Row>(
      `SELECT id, level, kind, ref_json, message, created_at FROM app_events
        WHERE ${OWNER}
          ${level === undefined ? "" : "AND level = ?"}
          ${before === undefined ? "" : "AND (created_at, id) < (?, ?)"}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      ownerId, ...(level === undefined ? [] : [level]), ...(before ?? []), limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(({ ref_json, ...row }) => ({ ...row, ref: JSON.parse(ref_json) as Refs })),
      next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString("base64url") : null,
    };
  }

  async piCounts(tx: SqlExecutor, ownerId: string): Promise<{ total: number; by_kind: Record<string, number> }> {
    const rows = await tx.all<{ kind: string; count: number }>(
      `SELECT json_extract(ref_json, '$.report_kind') AS kind, COUNT(*) AS count
         FROM app_events WHERE ${OWNER} AND kind LIKE 'pi.%' GROUP BY 1 ORDER BY 1`,
      ownerId,
    );
    return { total: rows.reduce((n, row) => n + row.count, 0), by_kind: Object.fromEntries(rows.map(({ kind, count }) => [kind, count])) };
  }

  /** Harness 的连接可能已经失效。同步落一条无正文的记录，下一次启动再补入 SQLite。 */
  spoolStorageFailure(path: string, ownerId: string): void {
    const at = this.#clock.now();
    appendFileSync(path, JSON.stringify({ id: uuidv7(at), owner_id: ownerId, at }) + "\n", { flush: true });
  }

  async importStorageFailures(path: string, ownerId: string): Promise<void> {
    let lines: string[];
    try {
      lines = readFileSync(path, "utf8").split("\n");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    await this.#db.transaction(async (tx) => {
      for (const line of lines) {
        let marker: { id?: unknown; owner_id?: unknown; at?: unknown } | null;
        try {
          marker = JSON.parse(line) as typeof marker;
        } catch {
          continue;
        }
        if (marker?.owner_id !== ownerId || typeof marker.id !== "string" || !ID.test(marker.id) || typeof marker.at !== "number" || !Number.isSafeInteger(marker.at)) continue;
        await insert(tx, ownerId, marker.at, "pi.storage_failed", "error", { report_kind: "storage_failed" }, "storage_failed", marker.id);
      }
    });
    rmSync(path, { force: true });
  }
}

async function insert(tx: SqlExecutor, ownerId: string, at: number, kind: string, level: Level, refs: Refs, state: string, id = uuidv7(at)) {
  await tx.run(
    "INSERT INTO app_events (id, level, kind, ref_json, message, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    id, level, kind, JSON.stringify({ ...refs, owner_id: ownerId }), state, at,
  );
}

function decodeCursor(cursor: string): [number, string] {
  try {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(cursor)) throw new Error("bad cursor");
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value) && value.length === 2 && Number.isSafeInteger(value[0]) && typeof value[1] === "string" && ID.test(value[1])) {
      return [value[0] as number, value[1]];
    }
  } catch {
    // 统一返回不透明游标校验错误。
  }
  throw new AppError("invalid_request", "cursor 无效", { issues: [{ path: "cursor" }] });
}
