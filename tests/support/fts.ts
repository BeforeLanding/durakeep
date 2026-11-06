// 04 §5 不变式 2 的检查：app_chunks 与两张 FTS 表的 rowid 必须一一对应。
type Rows = Record<string, unknown>[];
export type Query = (sql: string) => Promise<Rows> | Rows;

export type FtsReport = {
  chunks: number;
  fts: number;
  tri: number;
  /** 有块但缺 FTS 行 / trigram 行的块 id */
  missingFts: number[];
  missingTri: number[];
  /** FTS 行存在但没有对应块（孤儿） */
  orphanFts: number[];
  orphanTri: number[];
  /** active=1 但缺任何一张 FTS 表的行（不变式 2 的字面含义） */
  activeWithoutFts: number[];
};

const ids = (rows: Rows, key: string) => rows.map((r) => Number(r[key]));

export async function ftsReport(q: Query): Promise<FtsReport> {
  const count = async (sql: string) => Number((await q(sql))[0]!.c);
  return {
    chunks: await count("SELECT COUNT(*) AS c FROM app_chunks"),
    fts: await count("SELECT COUNT(*) AS c FROM app_chunks_fts"),
    tri: await count("SELECT COUNT(*) AS c FROM app_chunks_tri"),
    missingFts: ids(await q("SELECT id FROM app_chunks WHERE id NOT IN (SELECT rowid FROM app_chunks_fts)"), "id"),
    missingTri: ids(await q("SELECT id FROM app_chunks WHERE id NOT IN (SELECT rowid FROM app_chunks_tri)"), "id"),
    orphanFts: ids(await q("SELECT rowid AS id FROM app_chunks_fts WHERE rowid NOT IN (SELECT id FROM app_chunks)"), "id"),
    orphanTri: ids(await q("SELECT rowid AS id FROM app_chunks_tri WHERE rowid NOT IN (SELECT id FROM app_chunks)"), "id"),
    activeWithoutFts: ids(
      await q("SELECT id FROM app_chunks WHERE active = 1 AND (id NOT IN (SELECT rowid FROM app_chunks_fts) OR id NOT IN (SELECT rowid FROM app_chunks_tri))"),
      "id",
    ),
  };
}

/** 一致：没有缺失、没有孤儿，三张表行数相等。 */
export function ftsConsistent(r: FtsReport): boolean {
  return (
    r.missingFts.length === 0 &&
    r.missingTri.length === 0 &&
    r.orphanFts.length === 0 &&
    r.orphanTri.length === 0 &&
    r.activeWithoutFts.length === 0 &&
    r.chunks === r.fts &&
    r.chunks === r.tri
  );
}
