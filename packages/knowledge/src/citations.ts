import type { RawCitation } from "@durakeep/core";
import type { SqlDatabase } from "@durakeep/db";

// 07 §4.1：引用校验。三项：
//  1. 存在：chunk_id 存在，且属于当前 owner；
//  2. 有效：所在资料不是 revoked / purged，片段 active=1（旧版本的片段 active=0）；
//  3. 来自这次 run：chunk_id 出现在同一次 run 的 kb_search / kb_get_source 结果里（inRun，由运行时填写）——
//     挡住模型凭空写出、恰好存在的片段 ID。
// 校验只能证明“引用的东西真实存在、而且模型确实看过”，不能证明它支持那句话（08 §5 由评测时人工判定）。
// 每次展示都重新校验（不存储结果）：回答生成期间或之后资料被停止使用，引用立即变红；恢复后又变回有效。

export type InvalidReason =
  | "missing" // 不存在、属于别人（不区分，避免泄露存在性）、或引用格式无法解析
  | "purged" // 资料已彻底删除或正在删除
  | "revoked" // 资料已停止使用
  | "superseded" // 资料有了新版本，被引用的片段属于旧版本
  | "not_in_run" // 片段真实存在，但模型在这次 run 里并没有检索到它
  | "unresolved"; // 正文里有 [n] 标记，但没有对应的引用条目

export type Citation = {
  n: number;
  chunkId: number | null;
  valid: boolean;
  invalidReason?: InvalidReason;
  /** 仅 valid 时提供：引用定位（FR-KB-05：document_id、version_id、chunk_id 和字符区间）。 */
  documentId?: string;
  versionId?: string;
  title?: string;
  loc?: string;
  charStart?: number;
  charEnd?: number;
};

type Row = {
  id: number;
  document_id: string;
  version_id: string;
  heading_path: string;
  char_start: number;
  char_end: number;
  active: number;
  status: string;
  title: string;
  current_version_id: string | null;
};

export class CitationValidator {
  readonly #db: SqlDatabase;
  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** 校验一条回答里的全部引用；正文里有标记却没有引用条目的，追加 unresolved。 */
  async validate(ownerId: string, citations: RawCitation[], markers: number[] = []): Promise<Citation[]> {
    const ids = [...new Set(citations.map((c) => c.chunkId).filter((x): x is number => x !== null))];
    const rows = new Map<number, Row>();
    if (ids.length > 0) {
      const found = await this.#db.all<Row>(
        `SELECT c.id, c.document_id, c.version_id, c.heading_path, c.char_start, c.char_end, c.active,
                d.status, d.title, d.current_version_id
           FROM app_chunks c JOIN app_documents d ON d.id = c.document_id AND d.owner_id = c.owner_id
          WHERE c.owner_id = ? AND c.id IN (${ids.map(() => "?").join(",")})`,
        ownerId,
        ...ids,
      );
      for (const r of found) rows.set(r.id, r);
    }
    const out: Citation[] = citations.map((c) => this.#one(c, c.chunkId === null ? undefined : rows.get(c.chunkId)));
    const declared = new Set(citations.map((c) => c.n));
    for (const n of markers) if (!declared.has(n)) out.push({ n, chunkId: null, valid: false, invalidReason: "unresolved" });
    return out.sort((a, b) => a.n - b.n);
  }

  #one(c: RawCitation, r: Row | undefined): Citation {
    const bad = (reason: InvalidReason): Citation => ({ n: c.n, chunkId: c.chunkId, valid: false, invalidReason: reason });
    if (!r) return bad("missing");
    if (r.status === "purged" || r.status === "purging") return bad("purged");
    if (r.status === "revoked") return bad("revoked");
    if (r.current_version_id !== null && r.version_id !== r.current_version_id) return bad("superseded");
    if (r.active !== 1) return bad("revoked"); // 其余 active=0 的情形（如索引尚未完成）：当作不可用
    if (!c.inRun) return bad("not_in_run");
    return {
      n: c.n,
      chunkId: c.chunkId,
      valid: true,
      documentId: r.document_id,
      versionId: r.version_id,
      title: r.title,
      ...(r.heading_path ? { loc: r.heading_path } : {}),
      charStart: r.char_start,
      charEnd: r.char_end,
    };
  }
}
