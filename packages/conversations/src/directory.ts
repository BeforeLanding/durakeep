import type { SqlDatabase } from "@durakeep/db";

/** 工具与 AppGuard 需要的最小查询：按 Pi 会话 ID 找到业务会话与 owner。只依赖 db，不依赖 runtime（避免启动时的循环依赖）。 */
export interface ConversationLookup {
  byPiId(piConversationId: string): Promise<{ id: string; ownerId: string; archived: boolean } | undefined>;
}

export class ConversationDirectory implements ConversationLookup {
  readonly #db: SqlDatabase;
  constructor(db: SqlDatabase) {
    this.#db = db;
  }
  async byPiId(piConversationId: string): Promise<{ id: string; ownerId: string; archived: boolean } | undefined> {
    const r = await this.#db.get<{ id: string; owner_id: string; archived_at: number | null }>(
      "SELECT id, owner_id, archived_at FROM app_conversations WHERE pi_conversation_id = ? AND kind = 'chat'",
      piConversationId,
    );
    return r ? { id: r.id, ownerId: r.owner_id, archived: r.archived_at !== null } : undefined;
  }
}
