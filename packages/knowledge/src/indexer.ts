import { fault } from "@durakeep/core";
import type { SqlDatabase, SqlExecutor } from "@durakeep/db";
import { chunkMarkdown, type Chunk } from "./chunker.ts";
import type { Indexer } from "./knowledge.ts";
import { segmentForIndex } from "./segment.ts";

export const DEFAULT_BATCH = 25;

/**
 * 分块 → 分词 → 写入 app_chunks 与两张 FTS 表（04 §3）。
 *
 * - **分批**：每批在一个事务里写入若干块及其两张 FTS 行，所以任何时刻“块”与“FTS 行”都成对存在（不变式 2）；
 *   批与批之间让出事件循环，避免长时间占住连接队列、卡住对话的提交（ADR-02）。
 * - **可续**：分块是确定的。重试时先核对库里已有的块是不是新分块结果的前缀，是就从下一个序号继续，
 *   不是（正文或分块器变了）就整版重建；不会产生重复的块。
 * - 写入时块是 inactive 的：版本在所有批次完成并被设为当前版本之前不可检索；由 KnowledgeService 统一翻转 active。
 */
export function createChunkIndexer(db: SqlDatabase, opts: { batchSize?: number } = {}): Indexer {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH;
  return async ({ ownerId, documentId, versionId, text }) => {
    const chunks = chunkMarkdown(text);
    const existing = await db.all<{ ordinal: number; char_start: number; char_end: number }>(
      "SELECT ordinal, char_start, char_end FROM app_chunks WHERE owner_id = ? AND version_id = ? ORDER BY ordinal",
      ownerId,
      versionId,
    );
    let from = 0;
    const consistent =
      existing.length <= chunks.length &&
      existing.every((e, i) => e.ordinal === i && e.char_start === chunks[i]!.charStart && e.char_end === chunks[i]!.charEnd);
    if (consistent) from = existing.length;
    else await db.transaction((tx) => deleteVersionChunks(tx, ownerId, versionId));

    for (let i = from; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      await db.transaction(async (tx) => {
        for (const c of batch) await insertChunk(tx, { ownerId, documentId, versionId }, c);
      });
      fault("job.mid_index"); // 第 N 批写入之后、其余批次之前（R13）
      await new Promise<void>((r) => setImmediate(r));
    }
  };
}

async function insertChunk(tx: SqlExecutor, v: { ownerId: string; documentId: string; versionId: string }, c: Chunk): Promise<void> {
  await tx.run(
    `INSERT INTO app_chunks (version_id, document_id, owner_id, ordinal, heading_path, char_start, char_end, text, token_estimate, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    v.versionId,
    v.documentId,
    v.ownerId,
    c.ordinal,
    c.headingPath,
    c.charStart,
    c.charEnd,
    c.text,
    c.tokenEstimate,
  );
  const id = (await tx.get<{ id: number }>("SELECT last_insert_rowid() AS id"))!.id;
  await tx.run("INSERT INTO app_chunks_fts (rowid, seg_text, heading_seg) VALUES (?, ?, ?)", id, segmentForIndex(c.text), segmentForIndex(c.headingPath));
  await tx.run("INSERT INTO app_chunks_tri (rowid, text) VALUES (?, ?)", id, c.text);
}

/** 删除一个版本的全部块及其 FTS 行（重建、彻底删除时使用）。 */
export async function deleteVersionChunks(tx: SqlExecutor, ownerId: string, versionId: string): Promise<void> {
  const ids = "SELECT id FROM app_chunks WHERE owner_id = ? AND version_id = ?";
  await tx.run(`DELETE FROM app_chunks_fts WHERE rowid IN (${ids})`, ownerId, versionId);
  await tx.run(`DELETE FROM app_chunks_tri WHERE rowid IN (${ids})`, ownerId, versionId);
  await tx.run("DELETE FROM app_chunks WHERE owner_id = ? AND version_id = ?", ownerId, versionId);
}

/**
 * 翻转 active：只有“当前版本”的块、并且资料没有被停止使用时才可检索（旧版本的块保留但不再被搜到）。
 * FTS 行不动——查询时按 active 过滤，所以停止使用 / 恢复是 O(块数) 的一条 UPDATE。
 */
export async function setActiveChunks(tx: SqlExecutor, ownerId: string, documentId: string, currentVersionId: string | null, documentActive: boolean): Promise<void> {
  await tx.run(
    "UPDATE app_chunks SET active = CASE WHEN version_id = ? AND ? = 1 THEN 1 ELSE 0 END WHERE owner_id = ? AND document_id = ?",
    currentVersionId ?? "",
    documentActive ? 1 : 0,
    ownerId,
    documentId,
  );
}
