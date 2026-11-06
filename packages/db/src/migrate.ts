import type { SqlDatabase } from "./sql.ts";

/** 迁移按顺序追加，已发布的条目不得修改。表名统一 app_ 前缀（ADR-02）。 */
export const MIGRATIONS: readonly { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE app_probe (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id TEXT NOT NULL,
        n INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX app_probe_owner ON app_probe(owner_id, n);
    `,
  },
  {
    id: 2,
    sql: `
      CREATE TABLE app_operations (
        owner_id TEXT NOT NULL,
        op_key TEXT NOT NULL,
        tool TEXT NOT NULL,
        args_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (owner_id, op_key)
      );
    `,
  },
  {
    id: 3,
    sql: `
      CREATE TABLE app_owners (
        id           TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        timezone     TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        created_at   INTEGER NOT NULL
      );
      CREATE TABLE app_auth (
        owner_id      TEXT PRIMARY KEY REFERENCES app_owners(id),
        password_hash TEXT NOT NULL,
        failed_count  INTEGER NOT NULL DEFAULT 0,
        locked_until  INTEGER,
        updated_at    INTEGER NOT NULL
      );
      CREATE TABLE app_sessions (
        token_hash   TEXT PRIMARY KEY,
        owner_id     TEXT NOT NULL REFERENCES app_owners(id),
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX app_sessions_owner ON app_sessions(owner_id);
    `,
  },
  {
    id: 4,
    sql: `
      CREATE TABLE app_conversations (
        id                 TEXT PRIMARY KEY,
        owner_id           TEXT NOT NULL REFERENCES app_owners(id),
        pi_conversation_id TEXT NOT NULL UNIQUE,
        kind               TEXT NOT NULL CHECK (kind IN ('chat','background')),
        title              TEXT NOT NULL DEFAULT '新对话',
        created_at         INTEGER NOT NULL,
        last_active_at     INTEGER NOT NULL,
        archived_at        INTEGER
      );
      CREATE INDEX app_conversations_owner ON app_conversations(owner_id, kind, last_active_at DESC);

      CREATE TABLE app_ingress_events (
        id                TEXT PRIMARY KEY,
        owner_id          TEXT NOT NULL,
        channel           TEXT NOT NULL CHECK (channel IN ('web','system')),
        client_request_id TEXT NOT NULL,
        conversation_id   TEXT NOT NULL REFERENCES app_conversations(id),
        payload_hash      TEXT NOT NULL,
        payload_json      TEXT,
        pi_request_id     TEXT NOT NULL,
        submission_id     TEXT,
        status            TEXT NOT NULL CHECK (status IN ('accepted','dispatched','rejected')),
        reject_reason     TEXT,
        created_at        INTEGER NOT NULL,
        dispatched_at     INTEGER,
        UNIQUE (owner_id, channel, client_request_id)
      );
      CREATE INDEX app_ingress_pending ON app_ingress_events(status) WHERE status = 'accepted';
    `,
  },
];

export async function migrate(db: SqlDatabase): Promise<number> {
  await db.exec("CREATE TABLE IF NOT EXISTS app_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  let applied = 0;
  for (const m of MIGRATIONS) {
    await db.transaction(async (tx) => {
      const done = await tx.get<{ id: number }>("SELECT id FROM app_migrations WHERE id = ?", m.id);
      if (done) return;
      await tx.exec(m.sql);
      await tx.run("INSERT INTO app_migrations (id, applied_at) VALUES (?, ?)", m.id, Date.now());
      applied++;
    });
  }
  return applied;
}
