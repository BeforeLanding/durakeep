import { AppError, uuidv7 } from "@durakeep/core";
import type { SqlExecutor } from "@durakeep/db";

export type SourceType = "text" | "markdown" | "url";
export type DocumentStatus = "pending" | "ready" | "failed" | "revoked" | "purging" | "purged";

export type DocumentRow = {
  id: string;
  ownerId: string;
  sourceType: SourceType;
  sourceUri: string | null;
  title: string;
  status: DocumentStatus;
  currentVersionId: string | null;
  tags: string[];
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
};

export type VersionRow = {
  id: string;
  documentId: string;
  ownerId: string;
  contentHash: string;
  rawBlob: string;
  textBlob: string | null;
  parserVersion: string;
  status: "parsing" | "indexing" | "ready" | "failed" | "purged";
  title: string | null;
  summary: string | null;
  summaryEdited: boolean;
  charCount: number | null;
  capturedAt: number;
};

type DocRaw = {
  id: string;
  owner_id: string;
  source_type: SourceType;
  source_uri: string | null;
  title: string;
  status: DocumentStatus;
  current_version_id: string | null;
  tags_json: string;
  error_code: string | null;
  created_at: number;
  updated_at: number;
};
type VerRaw = {
  id: string;
  document_id: string;
  owner_id: string;
  content_hash: string;
  raw_blob: string;
  text_blob: string | null;
  parser_version: string;
  status: VersionRow["status"];
  title: string | null;
  summary: string | null;
  summary_edited: number;
  char_count: number | null;
  captured_at: number;
};

const DOC_COLS = "id, owner_id, source_type, source_uri, title, status, current_version_id, tags_json, error_code, created_at, updated_at";
const VER_COLS = "id, document_id, owner_id, content_hash, raw_blob, text_blob, parser_version, status, title, summary, summary_edited, char_count, captured_at";

const toDoc = (r: DocRaw): DocumentRow => ({
  id: r.id,
  ownerId: r.owner_id,
  sourceType: r.source_type,
  sourceUri: r.source_uri,
  title: r.title,
  status: r.status,
  currentVersionId: r.current_version_id,
  tags: JSON.parse(r.tags_json) as string[],
  errorCode: r.error_code,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toVer = (r: VerRaw): VersionRow => ({
  id: r.id,
  documentId: r.document_id,
  ownerId: r.owner_id,
  contentHash: r.content_hash,
  rawBlob: r.raw_blob,
  textBlob: r.text_blob,
  parserVersion: r.parser_version,
  status: r.status,
  title: r.title,
  summary: r.summary,
  summaryEdited: r.summary_edited === 1,
  charCount: r.char_count,
  capturedAt: r.captured_at,
});

export const MAX_TAGS = 10;

/** 标签：去首尾空白、去重（保序）、每个 1–32 个字符、至多 10 个。 */
export function normalizeTags(tags: unknown): string[] {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
    throw new AppError("invalid_request", "tags 必须是字符串数组", { issues: [{ path: "tags" }] });
  }
  const out: string[] = [];
  for (const raw of tags as string[]) {
    const t = raw.trim();
    if (t === "" || Array.from(t).length > 32) throw new AppError("invalid_request", "每个标签需为 1–32 个字符", { issues: [{ path: "tags" }] });
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TAGS) throw new AppError("invalid_request", `标签最多 ${MAX_TAGS} 个`, { issues: [{ path: "tags" }] });
  return out;
}

export async function getDocument(tx: SqlExecutor, ownerId: string, id: string): Promise<DocumentRow> {
  const r = await tx.get<DocRaw>(`SELECT ${DOC_COLS} FROM app_documents WHERE owner_id = ? AND id = ?`, ownerId, id);
  if (!r || r.status === "purged") throw new AppError("not_found", "资料不存在");
  return toDoc(r);
}

export async function findDocumentByUri(tx: SqlExecutor, ownerId: string, uri: string): Promise<DocumentRow | undefined> {
  const r = await tx.get<DocRaw>(`SELECT ${DOC_COLS} FROM app_documents WHERE owner_id = ? AND source_uri = ?`, ownerId, uri);
  return r ? toDoc(r) : undefined;
}

/** 同一 owner 下内容哈希相同、且仍在使用（pending / ready / revoked）的文本类资料。 */
export async function findTextDuplicate(tx: SqlExecutor, ownerId: string, contentHash: string): Promise<DocumentRow | undefined> {
  const r = await tx.get<DocRaw>(
    `SELECT ${DOC_COLS.split(", ").map((c) => `d.${c}`).join(", ")}
       FROM app_documents d JOIN app_document_versions v ON v.document_id = d.id
      WHERE d.owner_id = ? AND v.content_hash = ? AND d.source_type IN ('text','markdown') AND d.status IN ('pending','ready','revoked')
      ORDER BY d.created_at LIMIT 1`,
    ownerId,
    contentHash,
  );
  return r ? toDoc(r) : undefined;
}

export async function insertDocument(
  tx: SqlExecutor,
  now: number,
  d: { ownerId: string; sourceType: SourceType; sourceUri: string | null; title: string; tags: string[] },
): Promise<DocumentRow> {
  const id = uuidv7(now);
  await tx.run(
    `INSERT INTO app_documents (id, owner_id, source_type, source_uri, title, status, tags_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    id,
    d.ownerId,
    d.sourceType,
    d.sourceUri,
    d.title,
    JSON.stringify(d.tags),
    now,
    now,
  );
  return getDocument(tx, d.ownerId, id);
}

export async function insertVersion(
  tx: SqlExecutor,
  now: number,
  v: { documentId: string; ownerId: string; contentHash: string; rawBlob: string; parserVersion: string },
): Promise<VersionRow> {
  const id = uuidv7(now);
  await tx.run(
    `INSERT INTO app_document_versions (id, document_id, owner_id, content_hash, raw_blob, parser_version, status, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, 'parsing', ?)`,
    id,
    v.documentId,
    v.ownerId,
    v.contentHash,
    v.rawBlob,
    v.parserVersion,
    now,
  );
  return (await getVersion(tx, v.ownerId, id))!;
}

export async function getVersion(tx: SqlExecutor, ownerId: string, id: string): Promise<VersionRow | undefined> {
  const r = await tx.get<VerRaw>(`SELECT ${VER_COLS} FROM app_document_versions WHERE owner_id = ? AND id = ?`, ownerId, id);
  return r ? toVer(r) : undefined;
}

export async function findVersionByHash(tx: SqlExecutor, ownerId: string, documentId: string, contentHash: string): Promise<VersionRow | undefined> {
  const r = await tx.get<VerRaw>(
    `SELECT ${VER_COLS} FROM app_document_versions WHERE owner_id = ? AND document_id = ? AND content_hash = ?`,
    ownerId,
    documentId,
    contentHash,
  );
  return r ? toVer(r) : undefined;
}

export async function listVersions(tx: SqlExecutor, ownerId: string, documentId: string): Promise<VersionRow[]> {
  const rows = await tx.all<VerRaw>(
    `SELECT ${VER_COLS} FROM app_document_versions WHERE owner_id = ? AND document_id = ? AND status != 'purged' ORDER BY captured_at DESC, id DESC`,
    ownerId,
    documentId,
  );
  return rows.map(toVer);
}

export async function listDocuments(
  tx: SqlExecutor,
  ownerId: string,
  opts: { status?: string; tag?: string; q?: string; limit: number; after?: { at: number; id: string } },
): Promise<DocumentRow[]> {
  const where = ["owner_id = ?", "status != 'purged'"];
  const args: (string | number)[] = [ownerId];
  if (opts.status) {
    where.push("status = ?");
    args.push(opts.status);
  }
  if (opts.tag) {
    where.push("EXISTS (SELECT 1 FROM json_each(app_documents.tags_json) WHERE json_each.value = ?)");
    args.push(opts.tag);
  }
  if (opts.q) {
    // 06：q 按标题前缀匹配（转义 LIKE 通配符）
    where.push("title LIKE ? ESCAPE '\\'");
    args.push(opts.q.replace(/[\\%_]/g, (c) => `\\${c}`) + "%");
  }
  if (opts.after) {
    where.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
    args.push(opts.after.at, opts.after.at, opts.after.id);
  }
  const rows = await tx.all<DocRaw>(
    `SELECT ${DOC_COLS} FROM app_documents WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ...args,
    opts.limit + 1,
  );
  return rows.map(toDoc);
}
