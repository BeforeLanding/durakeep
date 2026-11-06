import type { SqlExecutor } from "@durakeep/db";
import { buildMatchQuery, segment, substringQuery } from "./segment.ts";

// 07 §3.2 的两路检索（词法 / 子串）。RRF 融合、相邻去冗余、输出截断在 T-15 的检索服务里做。

export type Hit = {
  chunkId: number;
  documentId: string;
  versionId: string;
  ordinal: number;
  headingPath: string;
  text: string;
  /** FTS5 的 bm25 值：越小（越负）越相关。 */
  score: number;
};

type Row = { id: number; document_id: string; version_id: string; ordinal: number; heading_path: string; text: string; score: number };
const toHit = (r: Row): Hit => ({ chunkId: r.id, documentId: r.document_id, versionId: r.version_id, ordinal: r.ordinal, headingPath: r.heading_path, text: r.text, score: r.score });

export type SearchOptions = { limit?: number; tag?: string };

const TAG_FILTER =
  "AND EXISTS (SELECT 1 FROM app_documents d, json_each(d.tags_json) j WHERE d.id = c.document_id AND d.owner_id = c.owner_id AND j.value = ?)";

/** 词法路：分词后在 app_chunks_fts 上用 bm25（标题列权重 2）排序。查询里一个词也没有时返回空。 */
export async function searchLexical(db: SqlExecutor, ownerId: string, query: string, opts: SearchOptions = {}): Promise<Hit[]> {
  const match = buildMatchQuery(segment(query));
  if (!match) return [];
  const rows = await db.all<Row>(
    `SELECT c.id, c.document_id, c.version_id, c.ordinal, c.heading_path, c.text, bm25(app_chunks_fts, 1.0, 2.0) AS score
       FROM app_chunks_fts JOIN app_chunks c ON c.id = app_chunks_fts.rowid
      WHERE app_chunks_fts MATCH ? AND c.owner_id = ? AND c.active = 1 ${opts.tag ? TAG_FILTER : ""}
      ORDER BY score LIMIT ?`,
    ...(opts.tag ? [match, ownerId, opts.tag, opts.limit ?? 20] : [match, ownerId, opts.limit ?? 20]),
  );
  return rows.map(toHit);
}

/** 子串路：只在查询里有连续 ≥3 个字符的片段时执行，用 trigram 表召回分词切错的子串。 */
export async function searchSubstring(db: SqlExecutor, ownerId: string, query: string, opts: SearchOptions = {}): Promise<Hit[]> {
  const match = substringQuery(query);
  if (!match) return [];
  const rows = await db.all<Row>(
    `SELECT c.id, c.document_id, c.version_id, c.ordinal, c.heading_path, c.text, bm25(app_chunks_tri) AS score
       FROM app_chunks_tri JOIN app_chunks c ON c.id = app_chunks_tri.rowid
      WHERE app_chunks_tri MATCH ? AND c.owner_id = ? AND c.active = 1 ${opts.tag ? TAG_FILTER : ""}
      ORDER BY score LIMIT ?`,
    ...(opts.tag ? [match, ownerId, opts.tag, opts.limit ?? 20] : [match, ownerId, opts.limit ?? 20]),
  );
  return rows.map(toHit);
}
