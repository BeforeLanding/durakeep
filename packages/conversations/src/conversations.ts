import { AppError, uuidv7, type Clock, type RuntimePort } from "@durakeep/core";
import type { SqlDatabase } from "@durakeep/db";
import { ConversationDirectory } from "./directory.ts";

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  archived: boolean;
};

export type ConversationRow = Conversation & { piConversationId: string };

type Row = {
  id: string;
  pi_conversation_id: string;
  title: string;
  created_at: number;
  last_active_at: number;
  archived_at: number | null;
};

const toRow = (r: Row): ConversationRow => ({
  id: r.id,
  piConversationId: r.pi_conversation_id,
  title: r.title,
  createdAt: r.created_at,
  lastActiveAt: r.last_active_at,
  archived: r.archived_at !== null,
});

export const toPublic = ({ piConversationId: _pi, ...c }: ConversationRow): Conversation => c;

const COLS = "id, pi_conversation_id, title, created_at, last_active_at, archived_at";

export function validateTitle(title: unknown): string {
  if (typeof title !== "string") throw new AppError("invalid_request", "title 必须是字符串");
  const t = title.trim();
  if (t.length < 1 || Array.from(t).length > 120) {
    throw new AppError("invalid_request", "title 长度需为 1–120 个字符", { issues: [{ path: "title" }] });
  }
  return t;
}

/** 会话的业务记录（FR-CHAT-06）。所有查询都带 owner_id；别人的会话与不存在不作区分（404）。 */
export class ConversationService {
  readonly #db: SqlDatabase;
  readonly #runtime: RuntimePort;
  readonly #clock: Clock;
  constructor(db: SqlDatabase, runtime: RuntimePort, clock: Clock) {
    this.#db = db;
    this.#runtime = runtime;
    this.#clock = clock;
  }

  async create(ownerId: string, title?: string): Promise<Conversation> {
    const t = title === undefined ? "新对话" : validateTitle(title);
    // 先建 Pi 会话再写业务行：两者之间崩溃只会留下无害的孤儿 Pi 会话（ADR-10）
    const { piConversationId } = await this.#runtime.createConversation({ kind: "chat" });
    const now = this.#clock.now();
    const id = uuidv7(now);
    await this.#db.run(
      "INSERT INTO app_conversations (id, owner_id, pi_conversation_id, kind, title, created_at, last_active_at) VALUES (?, ?, ?, 'chat', ?, ?, ?)",
      id,
      ownerId,
      piConversationId,
      t,
      now,
      now,
    );
    return { id, title: t, createdAt: now, lastActiveAt: now, archived: false };
  }

  /** 取得会话；不存在或不属于该 owner → 404。 */
  async get(ownerId: string, id: string): Promise<ConversationRow> {
    const r = await this.#db.get<Row>(
      `SELECT ${COLS} FROM app_conversations WHERE owner_id = ? AND id = ? AND kind = 'chat'`,
      ownerId,
      id,
    );
    if (!r) throw new AppError("not_found", "会话不存在");
    return toRow(r);
  }

  /** 工具与 AppGuard 用：按 Pi 会话 ID 找到业务会话（含 owner）。找不到返回 undefined。 */
  byPiId(piConversationId: string) {
    return new ConversationDirectory(this.#db).byPiId(piConversationId);
  }

  /** 取得可用于发送的会话：已归档视为不可用。 */
  async getActive(ownerId: string, id: string): Promise<ConversationRow> {
    const c = await this.get(ownerId, id);
    if (c.archived) throw new AppError("not_found", "会话不存在");
    return c;
  }

  /** 列表：只含 kind=chat，按 last_active_at 倒序；cursor 不透明。 */
  async list(
    ownerId: string,
    opts: { limit?: number; cursor?: string; includeArchived?: boolean } = {},
  ): Promise<{ items: Conversation[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    let after: { at: number; id: string } | undefined;
    if (opts.cursor !== undefined) {
      try {
        const [at, id] = Buffer.from(opts.cursor, "base64url").toString("utf8").split("|");
        if (at === undefined || id === undefined || !Number.isInteger(Number(at))) throw new Error("bad");
        after = { at: Number(at), id };
      } catch {
        throw new AppError("invalid_request", "cursor 无效", { issues: [{ path: "cursor" }] });
      }
    }
    const rows = await this.#db.all<Row>(
      `SELECT ${COLS} FROM app_conversations
        WHERE owner_id = ? AND kind = 'chat' ${opts.includeArchived ? "" : "AND archived_at IS NULL"}
          ${after ? "AND (last_active_at < ? OR (last_active_at = ? AND id < ?))" : ""}
        ORDER BY last_active_at DESC, id DESC LIMIT ?`,
      ...(after ? [ownerId, after.at, after.at, after.id, limit + 1] : [ownerId, limit + 1]),
    );
    const page = rows.slice(0, limit).map(toRow);
    const last = page.at(-1);
    return {
      items: page.map(toPublic),
      nextCursor: rows.length > limit && last ? Buffer.from(`${last.lastActiveAt}|${last.id}`).toString("base64url") : null,
    };
  }

  async update(ownerId: string, id: string, patch: { title?: unknown; archived?: unknown }): Promise<Conversation> {
    const cur = await this.get(ownerId, id);
    let title = cur.title;
    let archivedAt: number | null = cur.archived ? 1 : null;
    if (patch.title !== undefined) title = validateTitle(patch.title);
    if (patch.archived !== undefined) {
      if (typeof patch.archived !== "boolean") throw new AppError("invalid_request", "archived 必须是布尔值");
      archivedAt = patch.archived ? (cur.archived ? 1 : this.#clock.now()) : null;
    }
    if (archivedAt === 1) {
      // 已归档且保持归档：不改动原时间
      await this.#db.run("UPDATE app_conversations SET title = ? WHERE owner_id = ? AND id = ?", title, ownerId, id);
    } else {
      await this.#db.run(
        "UPDATE app_conversations SET title = ?, archived_at = ? WHERE owner_id = ? AND id = ?",
        title,
        archivedAt,
        ownerId,
        id,
      );
    }
    return toPublic(await this.get(ownerId, id));
  }

  async touch(ownerId: string, id: string): Promise<void> {
    await this.#db.run("UPDATE app_conversations SET last_active_at = ? WHERE owner_id = ? AND id = ?", this.#clock.now(), ownerId, id);
  }
}
