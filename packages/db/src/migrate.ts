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
