import type { Json } from "@durakeep/core";
import type { SqlDatabase } from "@durakeep/db";
import { searchLexical, searchSubstring, type Hit } from "./search.ts";
import { buildMatchQuery, segment, substringQuery } from "./segment.ts";

// 07 §3.2：两路检索 → RRF 融合 → 相邻命中合并 → 取 top_k → 输出（总长 ≤ 6,000 字符）。
// 05 §5.1：<source> 块，片段原文里的 </source> 要转义，防止标签被提前闭合（提示注入的第一道防线）。

export const RRF_K = 60;
export const ROUTE_LIMIT = 20;
export const DEFAULT_TOP_K = 6;
export const MAX_TOP_K = 10;
export const MAX_OUTPUT_CHARS = 6000;

export type ToolText = { text: string; details: Json; isError?: boolean };

/** 融合：score = Σ 1/(k + rank)，rank 从 1 起；每一路内部已按相关度排好序。 */
export function rrf(routes: Hit[][], k = RRF_K): Map<number, { hit: Hit; score: number }> {
  const out = new Map<number, { hit: Hit; score: number }>();
  for (const route of routes) {
    route.forEach((hit, i) => {
      const cur = out.get(hit.chunkId);
      const add = 1 / (k + i + 1);
      if (cur) cur.score += add;
      else out.set(hit.chunkId, { hit, score: add });
    });
  }
  return out;
}

export type Group = { versionId: string; documentId: string; headingPath: string; hits: Hit[]; best: Hit; score: number };

/**
 * 同一个版本中相邻（ordinal 相差 1）的命中合并成一个结果。按得分从高到低处理，
 * 新命中若与某个已有分组的首 / 尾相邻就并入它；分组得分取最高者。
 */
export function mergeAdjacent(ranked: { hit: Hit; score: number }[]): Group[] {
  const groups: Group[] = [];
  for (const { hit, score } of ranked) {
    const g = groups.find(
      (x) => x.versionId === hit.versionId && (hit.ordinal === x.hits[0]!.ordinal - 1 || hit.ordinal === x.hits[x.hits.length - 1]!.ordinal + 1),
    );
    if (g) {
      g.hits.push(hit);
      g.hits.sort((a, b) => a.ordinal - b.ordinal);
      if (score > g.score) {
        g.score = score;
        g.best = hit;
      }
    } else {
      groups.push({ versionId: hit.versionId, documentId: hit.documentId, headingPath: hit.headingPath, hits: [hit], best: hit, score });
    }
  }
  return groups.sort((a, b) => b.score - a.score || a.hits[0]!.chunkId - b.hits[0]!.chunkId);
}

/** 合并相邻块的文本：按字符区间去掉重叠部分；没有重叠（含表格续块）就用换行连接。 */
export function joinGroupText(hits: Hit[]): string {
  let text = hits[0]!.text;
  let end = hits[0]!.charEnd;
  for (const h of hits.slice(1)) {
    const overlap = end - h.charStart;
    text += overlap > 0 && overlap < h.text.length ? h.text.slice(overlap) : `\n${h.text}`;
    end = Math.max(end, h.charEnd);
  }
  return text;
}

/** 片段原文里的 <source 与 </source 一律转义，资料内容无法伪造或提前闭合标签。 */
export function escapeSourceText(s: string): string {
  return s.replace(/<(\/?)source/gi, "&lt;$1source");
}

const escapeAttr = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type SourceMeta = { title: string; capturedAt: number; sourceType: string };

export function renderSource(chunkId: number, chunkIds: number[], headingPath: string, text: string, meta: SourceMeta): string {
  const date = new Date(meta.capturedAt).toISOString().slice(0, 10);
  const how = meta.sourceType === "url" ? "抓取" : "收藏";
  const attrs = [`id="chunk:${chunkId}"`];
  if (chunkIds.length > 1) attrs.push(`chunks="${chunkIds.join(",")}"`);
  attrs.push(`title="${escapeAttr(meta.title)}"`, `version="${date} ${how}"`);
  if (headingPath) attrs.push(`loc="${escapeAttr(headingPath)}"`);
  return `<source ${attrs.join(" ")}>\n${escapeSourceText(text)}\n</source>`;
}

type DocRow = { id: string; title: string; source_type: string; captured_at: number };

export class KnowledgeRetrieval {
  readonly #db: SqlDatabase;
  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  async #docMeta(ownerId: string, versionIds: string[]): Promise<Map<string, SourceMeta>> {
    const out = new Map<string, SourceMeta>();
    if (versionIds.length === 0) return out;
    const rows = await this.#db.all<DocRow & { vid: string }>(
      `SELECT v.id AS vid, d.id, d.title, d.source_type, v.captured_at
         FROM app_document_versions v JOIN app_documents d ON d.id = v.document_id
        WHERE v.owner_id = ? AND v.id IN (${versionIds.map(() => "?").join(",")})`,
      ownerId,
      ...versionIds,
    );
    for (const r of rows) out.set(r.vid, { title: r.title, capturedAt: r.captured_at, sourceType: r.source_type });
    return out;
  }

  /** kb_search。所有过滤（owner、active、标签）都在查询里完成；引用校验时会再校验一次（T-16）。 */
  async search(ownerId: string, input: { query: string; topK?: number; tags?: string[] }): Promise<ToolText> {
    const topK = Math.min(Math.max(Math.trunc(input.topK ?? DEFAULT_TOP_K), 1), MAX_TOP_K);
    const tags = input.tags?.filter((t) => t.trim() !== "");
    const hasLex = buildMatchQuery(segment(input.query)) !== undefined;
    const hasSub = substringQuery(input.query) !== undefined;
    if (!hasLex && !hasSub) {
      return { text: "没有可用于检索的关键词（查询只包含停用词或标点），请换个说法。", details: { query: input.query, returned: 0, chunk_ids: [], results: [] } };
    }
    const opts = { limit: ROUTE_LIMIT, tags };
    const lexical = await searchLexical(this.#db, ownerId, input.query, opts);
    const substring = await searchSubstring(this.#db, ownerId, input.query, opts);
    const fused = [...rrf([lexical, substring]).values()].sort((a, b) => b.score - a.score || a.hit.chunkId - b.hit.chunkId);
    const groups = mergeAdjacent(fused).slice(0, topK);
    if (groups.length === 0) {
      return { text: "没有找到相关资料。可以换个说法，或者先收藏相关资料。", details: { query: input.query, returned: 0, chunk_ids: [], results: [] } };
    }
    const meta = await this.#docMeta(ownerId, [...new Set(groups.map((g) => g.versionId))]);
    const blocks: string[] = [];
    const results: Json[] = [];
    const shownIds: number[] = [];
    let used = 0;
    let omitted = 0;
    for (const g of groups) {
      const best = g.best;
      const ids = g.hits.map((h) => h.chunkId);
      const m = meta.get(g.versionId) ?? { title: "（未知）", capturedAt: 0, sourceType: "text" };
      const block = renderSource(best.chunkId, ids, best.headingPath, joinGroupText(g.hits), m);
      if (blocks.length > 0 && used + block.length > MAX_OUTPUT_CHARS) {
        omitted++; // 超出总长度的末尾结果被截掉；第一个结果永远保留
        continue;
      }
      blocks.push(block);
      used += block.length + 1;
      shownIds.push(...ids);
      results.push({ chunk_id: best.chunkId, chunk_ids: ids, document_id: g.documentId, version_id: g.versionId, title: m.title });
    }
    const footer = `（共 ${blocks.length} 条${omitted > 0 ? `；另有 ${omitted} 条因长度限制未显示` : ""}；如需上下文可调用 kb_get_source）`;
    return {
      text: `${blocks.join("\n")}\n${footer}`,
      // details 由工具写入、不含资料原文：引用校验（T-16）以它为准，而不是去解析可能被资料内容影响的文本
      details: { query: input.query, returned: blocks.length, omitted, chunk_ids: shownIds, results },
    };
  }

  /** kb_get_source：目标片段，以及前后各 expand 个片段（同一版本）。 */
  async getSource(ownerId: string, chunkId: number, expand = 0): Promise<ToolText> {
    const n = Math.min(Math.max(Math.trunc(expand), 0), 2);
    const target = await this.#db.get<{ version_id: string; ordinal: number }>(
      "SELECT version_id, ordinal FROM app_chunks WHERE owner_id = ? AND id = ? AND active = 1",
      ownerId,
      chunkId,
    );
    if (!target) return { text: "找不到这个片段：它不存在，或所在资料已停止使用。", details: { chunk_ids: [] }, isError: true };
    const rows = await this.#db.all<{ id: number; ordinal: number; heading_path: string; text: string; version_id: string }>(
      `SELECT id, ordinal, heading_path, text, version_id FROM app_chunks
        WHERE owner_id = ? AND version_id = ? AND active = 1 AND ordinal BETWEEN ? AND ? ORDER BY ordinal`,
      ownerId,
      target.version_id,
      target.ordinal - n,
      target.ordinal + n,
    );
    const meta = (await this.#docMeta(ownerId, [target.version_id])).get(target.version_id)!;
    return {
      text: rows.map((r) => renderSource(r.id, [r.id], r.heading_path, r.text, meta)).join("\n"),
      details: { chunk_ids: rows.map((r) => r.id) },
    };
  }

  /** kb_list_documents：标题、ID、状态；只列正在使用或处理中的资料（不含停用 / 失败 / 已删除）。 */
  async listDocuments(ownerId: string, input: { tag?: string; limit?: number }): Promise<ToolText> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 10), 1), 20);
    const rows = await this.#db.all<{ id: string; title: string; status: string; tags_json: string; source_type: string }>(
      `SELECT id, title, status, tags_json, source_type FROM app_documents
        WHERE owner_id = ? AND status IN ('ready','pending')
          ${input.tag ? "AND EXISTS (SELECT 1 FROM json_each(app_documents.tags_json) WHERE json_each.value = ?)" : ""}
        ORDER BY updated_at DESC, id DESC LIMIT ?`,
      ...(input.tag ? [ownerId, input.tag, limit] : [ownerId, limit]),
    );
    if (rows.length === 0) return { text: "没有符合条件的资料。", details: { document_ids: [] } };
    const lines = rows.map((r) => {
      const tags = (JSON.parse(r.tags_json) as string[]).join("、");
      return `- ${escapeSourceText(r.title)}（id=${r.id}，状态=${r.status === "pending" ? "处理中" : "可用"}${tags ? `，标签=${escapeSourceText(tags)}` : ""}）`;
    });
    return { text: lines.join("\n"), details: { document_ids: rows.map((r) => r.id) } };
  }
}
