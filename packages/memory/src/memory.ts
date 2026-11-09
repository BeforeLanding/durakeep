// 长期记忆（07 §5、04 §4.2）：写入、冲突处理（同 key 新值 → 旧记录 superseded）、revision、检索、状态流转、删除与 suppression。
// 每次 confirmed 集合变化，memory_set_revision:<owner> 加一（ADR-05：section 渲染的缓存键）。
import { createHash } from "node:crypto";
import { AppError, uuidv7, type Clock } from "@durakeep/core";
import type { SqlDatabase, SqlExecutor } from "@durakeep/db";

export type MemoryKind = "preference" | "profile_fact" | "project_context";
export type MemoryStatus = "candidate" | "confirmed" | "superseded" | "revoked" | "rejected";
export type ChangedBy = "user" | "tool" | "extractor";
export type MemorySource = { kind: "message" | "document" | "manual"; conversation_id?: string; entry_id?: string; version_id?: string; chunk_id?: number };

export type MemoryRow = {
  id: string;
  kind: MemoryKind;
  key: string;
  value: string;
  scope: string;
  status: MemoryStatus;
  revision: number;
  source: MemorySource;
  supersedesId: string | null;
  confirmedAt: number | null;
  createdAt: number;
  updatedAt: number;
};
export type RevisionRow = { revision: number; value: string; status: string; changedBy: ChangedBy; changedAt: number };

type Raw = {
  id: string; kind: MemoryKind; key: string; value: string; scope: string; status: MemoryStatus; revision: number;
  source_json: string; supersedes_id: string | null; confirmed_at: number | null; created_at: number; updated_at: number;
};
const map = (r: Raw): MemoryRow => ({
  id: r.id, kind: r.kind, key: r.key, value: r.value, scope: r.scope, status: r.status, revision: r.revision,
  source: JSON.parse(r.source_json) as MemorySource, supersedesId: r.supersedes_id, confirmedAt: r.confirmed_at, createdAt: r.created_at, updatedAt: r.updated_at,
});
const COLS = "id, kind, key, value, scope, status, revision, source_json, supersedes_id, confirmed_at, created_at, updated_at";

const KEY_RE = /^[a-z0-9_.]{1,64}$/;
const SCOPE_RE = /^(global|project:[^\s:]{1,40})$/;
const KINDS: readonly string[] = ["preference", "profile_fact", "project_context"];
export const MAX_VALUE = 200;

/** 模型给出的 key 由服务端规范化：去首尾空白、转小写（07 §5.1）。 */
export const normalizeKey = (k: string) => k.trim().toLowerCase();
const normalizeValue = (v: string) => v.normalize("NFC").replace(/\s+/g, " ").trim();
export const fingerprint = (scope: string, key: string, value: string) => createHash("sha256").update(`${scope}|${key}|${normalizeValue(value).toLowerCase()}`).digest("hex");

export type RememberInput = { kind: string; key: string; value: string; scope?: string; source: MemorySource; status?: "confirmed" | "candidate"; changedBy: ChangedBy };
export type RememberResult = { memoryId: string; revision: number; status: MemoryStatus; supersededValue: string | null; unchanged: boolean };

function validate(input: { kind: string; key: string; value: string; scope?: string }) {
  const key = normalizeKey(input.key);
  const value = normalizeValue(input.value);
  const scope = (input.scope ?? "global").trim();
  const issues: { path: string; message: string }[] = [];
  if (!KINDS.includes(input.kind)) issues.push({ path: "kind", message: "需为 preference、profile_fact 或 project_context" });
  if (!KEY_RE.test(key)) issues.push({ path: "key", message: "只能含小写字母、数字、. 和 _，≤64 字符" });
  if (value === "" || [...value].length > MAX_VALUE) issues.push({ path: "value", message: `需为 1–${MAX_VALUE} 个字符` });
  if (!SCOPE_RE.test(scope)) issues.push({ path: "scope", message: "需为 global 或 project:<名称>" });
  if (issues.length > 0) throw new AppError("invalid_request", `记忆参数无效：${issues.map((i) => `${i.path}（${i.message}）`).join("；")}`, { issues });
  return { key, value, scope, kind: input.kind as MemoryKind };
}

export class MemoryService {
  readonly #db: SqlDatabase;
  readonly #clock: Clock;
  constructor(db: SqlDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  // ---- 集合版本（ADR-05） ----
  static #settingKey = (ownerId: string) => `memory_set_revision:${ownerId}`;
  async setRevision(ownerId: string, db: SqlExecutor = this.#db): Promise<number> {
    const r = await db.get<{ value_json: string }>("SELECT value_json FROM app_settings WHERE key = ?", MemoryService.#settingKey(ownerId));
    return r ? (JSON.parse(r.value_json) as number) : 0;
  }
  async #bump(tx: SqlExecutor, ownerId: string, now: number) {
    const next = (await this.setRevision(ownerId, tx)) + 1;
    await tx.run(
      "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
      MemoryService.#settingKey(ownerId),
      JSON.stringify(next),
      now,
    );
  }
  async #revision(tx: SqlExecutor, m: { id: string }, revision: number, value: string, status: string, by: ChangedBy, now: number) {
    await tx.run("INSERT INTO app_memory_revisions (memory_id, revision, value, status, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?)", m.id, revision, value, status, by, now);
  }

  /**
   * 写入（事务内，供工具的 once() 与 HTTP 共用）。confirmed：同 scope+key 已有 confirmed 时，值相同 → 不变；值不同 → 旧记录 superseded，
   * 新记录 supersedes 它（FR-MEM-03）。candidate：只入库，不影响集合。显式写入会清除同值的 suppression（用户明确要这条）。
   */
  async rememberTx(tx: SqlExecutor, ownerId: string, input: RememberInput): Promise<RememberResult> {
    const v = validate(input);
    const now = this.#clock.now();
    const status = input.status ?? "confirmed";
    if (status === "candidate") {
      const fp = fingerprint(v.scope, v.key, v.value);
      if (await tx.get("SELECT 1 AS x FROM app_memory_suppressions WHERE owner_id = ? AND fingerprint = ?", ownerId, fp)) {
        throw new AppError("invalid_request", "这条记忆之前被拒绝或删除过，不再自动提取");
      }
    }
    const current = await tx.get<Raw>(`SELECT ${COLS} FROM app_memories WHERE owner_id = ? AND scope = ? AND key = ? AND status = 'confirmed'`, ownerId, v.scope, v.key);
    if (status === "confirmed" && current && normalizeValue(current.value) === v.value && current.kind === v.kind) {
      return { memoryId: current.id, revision: current.revision, status: "confirmed", supersededValue: null, unchanged: true };
    }
    const id = uuidv7(now);
    await tx.run(
      `INSERT INTO app_memories (id, owner_id, kind, key, value, scope, status, revision, source_json, supersedes_id, confirmed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'candidate', 1, ?, ?, NULL, ?, ?)`,
      id, ownerId, v.kind, v.key, v.value, v.scope, JSON.stringify(input.source), status === "confirmed" && current ? current.id : null, now, now,
    );
    if (status === "confirmed") {
      if (current) {
        await tx.run("UPDATE app_memories SET status = 'superseded', revision = revision + 1, updated_at = ? WHERE id = ?", now, current.id);
        await this.#revision(tx, current, current.revision + 1, current.value, "superseded", input.changedBy, now);
      }
      await tx.run("UPDATE app_memories SET status = 'confirmed', confirmed_at = ? WHERE id = ?", now, id);
      await tx.run("DELETE FROM app_memory_suppressions WHERE owner_id = ? AND fingerprint = ?", ownerId, fingerprint(v.scope, v.key, v.value));
      await this.#bump(tx, ownerId, now);
    }
    await this.#revision(tx, { id }, 1, v.value, status, input.changedBy, now);
    return { memoryId: id, revision: 1, status, supersededValue: current ? current.value : null, unchanged: false };
  }

  remember(ownerId: string, input: RememberInput): Promise<RememberResult> {
    return this.#db.transaction((tx) => this.rememberTx(tx, ownerId, input));
  }

  // ---- 读取 ----
  async get(ownerId: string, id: string, db: SqlExecutor = this.#db): Promise<MemoryRow> {
    const r = await db.get<Raw>(`SELECT ${COLS} FROM app_memories WHERE owner_id = ? AND id = ?`, ownerId, id);
    if (!r) throw new AppError("not_found", "记忆不存在");
    return map(r);
  }

  async list(ownerId: string, opts: { status?: string; limit?: number } = {}): Promise<MemoryRow[]> {
    const statuses = ["candidate", "confirmed", "superseded", "revoked", "rejected"];
    if (opts.status !== undefined && !statuses.includes(opts.status)) throw new AppError("invalid_request", "status 无效", { issues: [{ path: "status" }] });
    const rows = await this.#db.all<Raw>(
      `SELECT ${COLS} FROM app_memories WHERE owner_id = ? ${opts.status ? "AND status = ?" : ""} ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ...(opts.status ? [ownerId, opts.status, opts.limit ?? 200] : [ownerId, opts.limit ?? 200]),
    );
    return rows.map(map);
  }

  /** profile section 用：global 且 confirmed，按 key 排序（04 / 05 §4.2）。 */
  async globalConfirmed(ownerId: string, limit = 21): Promise<MemoryRow[]> {
    const rows = await this.#db.all<Raw>(`SELECT ${COLS} FROM app_memories WHERE owner_id = ? AND scope = 'global' AND status = 'confirmed' ORDER BY key ASC LIMIT ?`, ownerId, limit);
    return rows.map(map);
  }

  async revisions(ownerId: string, id: string): Promise<RevisionRow[]> {
    await this.get(ownerId, id);
    const rows = await this.#db.all<{ revision: number; value: string; status: string; changed_by: ChangedBy; changed_at: number }>(
      "SELECT revision, value, status, changed_by, changed_at FROM app_memory_revisions WHERE memory_id = ? ORDER BY revision ASC",
      id,
    );
    return rows.map((r) => ({ revision: r.revision, value: r.value, status: r.status, changedBy: r.changed_by, changedAt: r.changed_at }));
  }

  /** memory_search：只在 confirmed 里按 key 与 value 打分（记忆通常只有几百条，直接在内存中算）。 */
  async search(ownerId: string, query: string, scope?: string): Promise<MemoryRow[]> {
    const rows = await this.#db.all<Raw>(`SELECT ${COLS} FROM app_memories WHERE owner_id = ? AND status = 'confirmed' ${scope ? "AND scope = ?" : ""}`, ...(scope ? [ownerId, scope] : [ownerId]));
    const q = grams(query, false);
    if (q.size === 0) return [];
    return rows
      .map((r) => {
        const keyG = grams(r.key.replace(/[._]/g, " "));
        const valG = grams(r.value);
        let score = 0;
        for (const g of q) {
          if (valG.has(g)) score += 1;
          if (keyG.has(g)) score += 1.5;
        }
        return { r, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (a.r.key < b.r.key ? -1 : 1))
      .slice(0, 10)
      .map((x) => map(x.r));
  }

  // ---- 修改与状态流转 ----
  /** 修改 value / scope：revision 必须匹配（409 revision_conflict）；只对 candidate / confirmed 有效。 */
  async update(ownerId: string, id: string, patch: { value?: unknown; scope?: unknown; expected_revision?: unknown }, by: ChangedBy = "user"): Promise<MemoryRow> {
    if (typeof patch.expected_revision !== "number" || !Number.isInteger(patch.expected_revision)) {
      throw new AppError("invalid_request", "需要 expected_revision", { issues: [{ path: "expected_revision" }] });
    }
    return this.#db.transaction(async (tx) => {
      const m = await this.get(ownerId, id, tx);
      if (m.status !== "confirmed" && m.status !== "candidate") throw new AppError("invalid_request", "只能修改已确认或候选的记忆");
      if (m.revision !== patch.expected_revision) throw new AppError("revision_conflict", "记忆已被修改，请刷新后重试", { current_revision: m.revision });
      const next = validate({ kind: m.kind, key: m.key, value: typeof patch.value === "string" ? patch.value : m.value, scope: typeof patch.scope === "string" ? patch.scope : m.scope });
      if (next.value === m.value && next.scope === m.scope) return m;
      const now = this.#clock.now();
      if (m.status === "confirmed" && next.scope !== m.scope) {
        const clash = await tx.get("SELECT 1 AS x FROM app_memories WHERE owner_id = ? AND scope = ? AND key = ? AND status = 'confirmed' AND id <> ?", ownerId, next.scope, m.key, m.id);
        if (clash) throw new AppError("invalid_request", "目标作用范围里已有同名的已确认记忆");
      }
      await tx.run("UPDATE app_memories SET value = ?, scope = ?, revision = revision + 1, updated_at = ? WHERE id = ?", next.value, next.scope, now, m.id);
      await this.#revision(tx, m, m.revision + 1, next.value, m.status, by, now);
      if (m.status === "confirmed") await this.#bump(tx, ownerId, now);
      return this.get(ownerId, id, tx);
    });
  }

  /** 候选 → 已确认；同 key 已有 confirmed 时它被取代（FR-MEM-03）。 */
  async confirm(ownerId: string, id: string): Promise<MemoryRow> {
    return this.#db.transaction(async (tx) => {
      const m = await this.get(ownerId, id, tx);
      if (m.status !== "candidate") throw new AppError("invalid_request", "只有候选记忆可以确认");
      await this.#activate(tx, ownerId, m, "candidate");
      return this.get(ownerId, id, tx);
    });
  }

  /** revoked → confirmed（重新启用，revision+1）。 */
  async enable(ownerId: string, id: string): Promise<MemoryRow> {
    return this.#db.transaction(async (tx) => {
      const m = await this.get(ownerId, id, tx);
      if (m.status !== "revoked") throw new AppError("invalid_request", "只有已停用的记忆可以重新启用");
      await this.#activate(tx, ownerId, m, "revoked");
      return this.get(ownerId, id, tx);
    });
  }

  async #activate(tx: SqlExecutor, ownerId: string, m: MemoryRow, _from: string) {
    const now = this.#clock.now();
    const current = await tx.get<Raw>(`SELECT ${COLS} FROM app_memories WHERE owner_id = ? AND scope = ? AND key = ? AND status = 'confirmed' AND id <> ?`, ownerId, m.scope, m.key, m.id);
    if (current) {
      await tx.run("UPDATE app_memories SET status = 'superseded', revision = revision + 1, updated_at = ? WHERE id = ?", now, current.id);
      await this.#revision(tx, current, current.revision + 1, current.value, "superseded", "user", now);
    }
    await tx.run("UPDATE app_memories SET status = 'confirmed', revision = revision + 1, confirmed_at = ?, supersedes_id = COALESCE(?, supersedes_id), updated_at = ? WHERE id = ?", now, current ? current.id : null, now, m.id);
    await this.#revision(tx, m, m.revision + 1, m.value, "confirmed", "user", now);
    await this.#bump(tx, ownerId, now);
  }

  /** 候选 → 已拒绝，同时写入 suppression（不再被提取）。 */
  async reject(ownerId: string, id: string): Promise<MemoryRow> {
    return this.#db.transaction(async (tx) => {
      const m = await this.get(ownerId, id, tx);
      if (m.status !== "candidate") throw new AppError("invalid_request", "只有候选记忆可以拒绝");
      const now = this.#clock.now();
      await tx.run("UPDATE app_memories SET status = 'rejected', revision = revision + 1, updated_at = ? WHERE id = ?", now, m.id);
      await this.#revision(tx, m, m.revision + 1, m.value, "rejected", "user", now);
      await this.#suppress(tx, ownerId, m, "rejected", now);
      return this.get(ownerId, id, tx);
    });
  }

  /** 已确认 → 已停用：立即不再进入 section 和检索。 */
  async revoke(ownerId: string, id: string): Promise<MemoryRow> {
    return this.#db.transaction(async (tx) => {
      const m = await this.get(ownerId, id, tx);
      if (m.status !== "confirmed") throw new AppError("invalid_request", "只有已确认的记忆可以停用");
      const now = this.#clock.now();
      await tx.run("UPDATE app_memories SET status = 'revoked', revision = revision + 1, updated_at = ? WHERE id = ?", now, m.id);
      await this.#revision(tx, m, m.revision + 1, m.value, "revoked", "user", now);
      await this.#bump(tx, ownerId, now);
      return this.get(ownerId, id, tx);
    });
  }

  /** 任何状态 → 物理删除：写入 suppression，再删除这一行和它的 revisions（07 §6）。 */
  async delete(ownerId: string, id: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const m = await this.get(ownerId, id, tx);
      const now = this.#clock.now();
      await this.#suppress(tx, ownerId, m, "deleted", now);
      await tx.run("DELETE FROM app_memory_revisions WHERE memory_id = ?", m.id);
      await tx.run("UPDATE app_memories SET supersedes_id = NULL WHERE supersedes_id = ?", m.id);
      await tx.run("DELETE FROM app_memories WHERE id = ?", m.id);
      if (m.status === "confirmed") await this.#bump(tx, ownerId, now);
    });
  }

  async #suppress(tx: SqlExecutor, ownerId: string, m: MemoryRow, reason: "rejected" | "deleted", now: number) {
    await tx.run(
      "INSERT INTO app_memory_suppressions (owner_id, fingerprint, reason, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id, fingerprint) DO UPDATE SET reason = excluded.reason",
      ownerId,
      fingerprint(m.scope, m.key, m.value),
      reason,
      now,
    );
  }
}

/** 检索用的“词”：英文数字按词、中日韩按单字与相邻二字组合（与词典无关，足够应对几百条短记忆）。 */
function grams(s: string, indexSide = true): Set<string> {
  const out = new Set<string>();
  const text = s.normalize("NFKC").toLowerCase();
  for (const w of text.match(/[a-z0-9]+/g) ?? []) if (w.length > 1) out.add(w);
  for (const run of text.match(/[㐀-鿿]+/g) ?? []) {
    const cs = [...run];
    for (let i = 0; i < cs.length; i++) {
      // 单字：索引侧总是收录；查询侧只有“整段只有一个字”时才用（避免常用字造成噪声）
      if (indexSide || cs.length === 1) out.add(cs[i]!);
      if (i + 1 < cs.length) out.add(cs[i]! + cs[i + 1]!);
    }
  }
  return out;
}
