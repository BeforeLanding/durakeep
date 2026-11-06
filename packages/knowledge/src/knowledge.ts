import { AppError, fault, type Clock, type Json } from "@durakeep/core";
import { onceStrict, type SqlDatabase, type SqlExecutor } from "@durakeep/db";
import { enqueue, JobError, type JobContext, type JobHandler, type JobKind, type JobRow } from "@durakeep/jobs";
import type { BlobStore } from "./blob.ts";
import { decodeBody } from "./charset.ts";
import {
  findDocumentByUri,
  findTextDuplicate,
  findVersionByHash,
  getDocument,
  getVersion,
  insertDocument,
  insertVersion,
  listDocuments,
  listVersions,
  normalizeTags,
  type DocumentRow,
  type VersionRow,
} from "./documents.ts";
import { extractHtml, extractPlain, type Extracted } from "./extract.ts";
import { setActiveChunks } from "./indexer.ts";
import { CHUNKER_VERSION } from "./chunker.ts";
import { assertRobotsAllows, safeFetch, type FetchPolicy } from "./fetch.ts";
import { normalizeUrl, urlHash } from "./url.ts";

export const MAX_TEXT_CHARS = 500_000; // 07 / 03 §7：正文 ≤500k 字符
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 上传 ≤2 MB
export const MAX_TITLE_CHARS = 120;

export type LogFn = (e: { level: "info" | "warn" | "error"; event: string; [k: string]: string | number | boolean | undefined }) => void;

/** 索引阶段（T-14 接入分块 / 分词 / FTS）。T-13 之前没有索引，版本在抽取完成后直接 ready。 */
export type Indexer = (v: { ownerId: string; documentId: string; versionId: string; text: string }) => Promise<void>;

export type KnowledgeDeps = {
  db: SqlDatabase;
  blobs: BlobStore;
  clock: Clock;
  /** 抓取策略覆盖（测试用；生产为 DEFAULT_POLICY）。 */
  fetchPolicy?: Partial<FetchPolicy>;
  indexer?: Indexer;
  log?: LogFn;
  /** 入队后唤醒 JobWorker。 */
  wake?: () => void;
};

export type CaptureResult = { documentId: string; jobId: string | null; status: "pending" | "ready" | "revoked" | "failed"; deduplicated: boolean };

/** 一次写入的计划：args 用于幂等键与冲突检测；run 在调用方的事务里执行。 */
export type CapturePlan = { args: Json; run: (tx: SqlExecutor) => Promise<CaptureResult> };

export type CaptureTextInput = {
  clientRequestId: string;
  kind: "text" | "markdown";
  title?: string;
  text: string;
  tags?: unknown;
};
export type CaptureUrlInput = { clientRequestId: string; url: string; tags?: unknown };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERMANENT = new Set(["ssrf_blocked", "unsupported_type", "too_large", "robots_disallowed", "extract_failed", "invalid_request"]);

function requireRequestId(id: unknown): string {
  if (typeof id !== "string" || !UUID.test(id)) {
    throw new AppError("invalid_request", "client_request_id 必须是 UUID", { issues: [{ path: "client_request_id" }] });
  }
  return id;
}

function cleanTitle(t: unknown): string | undefined {
  if (t === undefined || t === null) return undefined;
  if (typeof t !== "string") throw new AppError("invalid_request", "title 必须是字符串", { issues: [{ path: "title" }] });
  // eslint-disable-next-line no-control-regex -- 有意剔除控制字符
  const s = t.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  if (s === "") return undefined;
  return Array.from(s).slice(0, MAX_TITLE_CHARS).join("");
}

/** 文本资料的默认标题：Markdown 的第一个标题，否则第一行非空文字（至多 60 个字符）。 */
function defaultTitle(text: string, kind: "text" | "markdown"): string {
  const ex = extractPlain(text, kind);
  if (ex.title) return Array.from(ex.title).slice(0, MAX_TITLE_CHARS).join("");
  const first = ex.markdown.split("\n").find((l) => l.trim() !== "")?.trim();
  return first ? Array.from(first).slice(0, 60).join("") : "未命名文本";
}

const dayKey = (now: number) => new Date(now).toISOString().slice(0, 10);

export class KnowledgeService {
  readonly #d: KnowledgeDeps;
  readonly #log: LogFn;
  constructor(deps: KnowledgeDeps) {
    this.#d = deps;
    this.#log = deps.log ?? (() => {});
  }

  // ---- 采集 ----------------------------------------------------------------

  /** 文本 / Markdown 的校验与准备：校验入参、原始字节写 blob（内容寻址，重复写入无害）；返回幂等用的规范化参数和事务内的写入函数。 */
  planCaptureText(ownerId: string, input: { kind: "text" | "markdown"; title?: string; text: unknown; tags?: unknown }): CapturePlan {
    if (typeof input.text !== "string" || input.text.trim() === "") {
      throw new AppError("invalid_request", "text 不能为空", { issues: [{ path: "text" }] });
    }
    const text: string = input.text;
    if (Array.from(text).length > MAX_TEXT_CHARS) throw new AppError("too_large", `正文不能超过 ${MAX_TEXT_CHARS} 个字符`);
    const tags = normalizeTags(input.tags);
    const userTitle = cleanTitle(input.title);
    const title = userTitle ?? defaultTitle(text, input.kind);
    const hash = this.#d.blobs.put(Buffer.from(text, "utf8"));
    const now = this.#d.clock.now();
    const args: Json = { type: input.kind, title: userTitle ?? null, hash, tags };
    return {
      args,
      run: async (tx) => {
        const dup = await findTextDuplicate(tx, ownerId, hash);
        if (dup) return { documentId: dup.id, jobId: null, status: dup.status as CaptureResult["status"], deduplicated: true };
        const doc = await insertDocument(tx, now, { ownerId, sourceType: input.kind, sourceUri: null, title, tags });
        await insertVersion(tx, now, { documentId: doc.id, ownerId, contentHash: hash, rawBlob: hash, parserVersion: "pending" });
        const { job } = await enqueue(tx, now, { ownerId, kind: "ingest_text", dedupeKey: `ingest_text:${doc.id}`, input: { documentId: doc.id, kind: input.kind } });
        return { documentId: doc.id, jobId: job.id, status: "pending" as const, deduplicated: false };
      },
    };
  }

  /** 文本 / Markdown（HTTP）：请求级幂等 + 上面的写入，在同一个事务里。 */
  async captureText(ownerId: string, input: CaptureTextInput): Promise<CaptureResult> {
    const crid = requireRequestId(input.clientRequestId);
    const plan = this.planCaptureText(ownerId, input);
    const r = await onceStrict(this.#d.db, ownerId, `http:capture:${crid}`, "capture", plan.args, plan.run);
    this.#d.wake?.();
    return { ...r.result, deduplicated: r.deduplicated || r.result.deduplicated };
  }

  /** URL 的校验与准备：规范化；返回幂等用的规范化参数和事务内的写入函数（资料 + 作业）。 */
  planCaptureUrl(ownerId: string, input: { url: unknown; tags?: unknown }): CapturePlan {
    if (typeof input.url !== "string") throw new AppError("invalid_request", "url 必须是字符串", { issues: [{ path: "url" }] });
    const url = normalizeUrl(input.url);
    const tags = normalizeTags(input.tags);
    const now = this.#d.clock.now();
    const args: Json = { type: "url", url, tags };
    return {
      args,
      run: async (tx) => {
        let doc = await findDocumentByUri(tx, ownerId, url);
        if (doc && (doc.status === "revoked" || doc.status === "purging" || doc.status === "purged")) {
          throw new AppError("invalid_request", doc.status === "revoked" ? "这篇资料已停止使用，请先恢复再重新采集" : "这篇资料正在被删除");
        }
        if (!doc) doc = await insertDocument(tx, now, { ownerId, sourceType: "url", sourceUri: url, title: url, tags });
        else if (tags.length > 0) {
          await tx.run("UPDATE app_documents SET tags_json = ?, updated_at = ? WHERE owner_id = ? AND id = ?", JSON.stringify(tags), now, ownerId, doc.id);
        }
        const { job, created } = await enqueue(tx, now, {
          ownerId,
          kind: "ingest_url",
          dedupeKey: `ingest_url:${urlHash(url)}:${dayKey(now)}`,
          input: { documentId: doc.id, url },
        });
        if (created && doc.status === "failed") {
          await tx.run("UPDATE app_documents SET status = 'pending', error_code = NULL, updated_at = ? WHERE owner_id = ? AND id = ?", now, ownerId, doc.id);
          doc = { ...doc, status: "pending" };
        }
        return { documentId: doc.id, jobId: job.id, status: doc.status as CaptureResult["status"], deduplicated: !created };
      },
    };
  }

  /** URL（HTTP）：请求级幂等 + 上面的写入。抓取在作业里进行。 */
  async captureUrl(ownerId: string, input: CaptureUrlInput): Promise<CaptureResult> {
    const crid = requireRequestId(input.clientRequestId);
    const plan = this.planCaptureUrl(ownerId, input);
    const r = await onceStrict(this.#d.db, ownerId, `http:capture:${crid}`, "capture", plan.args, plan.run);
    this.#d.wake?.();
    return { ...r.result, deduplicated: r.deduplicated || r.result.deduplicated };
  }

  /** 入队后唤醒作业队列（写工具在事务提交之后调用）。 */
  wake(): void {
    this.#d.wake?.();
  }

  // ---- 查询与状态 ------------------------------------------------------------

  async list(ownerId: string, opts: { status?: string; tag?: string; q?: string; limit?: number; cursor?: string }) {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    let after: { at: number; id: string } | undefined;
    if (opts.cursor !== undefined) {
      const [at, id] = Buffer.from(opts.cursor, "base64url").toString("utf8").split("|");
      if (at === undefined || id === undefined || !Number.isInteger(Number(at))) throw new AppError("invalid_request", "cursor 无效", { issues: [{ path: "cursor" }] });
      after = { at: Number(at), id };
    }
    const rows = await listDocuments(this.#d.db, ownerId, { ...opts, limit, after });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { items: page, nextCursor: rows.length > limit && last ? Buffer.from(`${last.updatedAt}|${last.id}`).toString("base64url") : null };
  }

  async detail(ownerId: string, id: string): Promise<{ document: DocumentRow; versions: VersionRow[] }> {
    const document = await getDocument(this.#d.db, ownerId, id);
    return { document, versions: await listVersions(this.#d.db, ownerId, id) };
  }

  /** 抽取出的正文（Markdown）。版本必须属于该资料且已抽取。 */
  async readText(ownerId: string, documentId: string, versionId: string): Promise<string> {
    const v = await this.#version(ownerId, documentId, versionId);
    if (!v.textBlob) throw new AppError("not_found", "正文尚未生成");
    return this.#d.blobs.getText(v.textBlob);
  }

  async readRaw(ownerId: string, documentId: string, versionId: string): Promise<{ bytes: Buffer; version: VersionRow; document: DocumentRow }> {
    const document = await getDocument(this.#d.db, ownerId, documentId);
    const version = await this.#version(ownerId, documentId, versionId);
    return { bytes: this.#d.blobs.get(version.rawBlob), version, document };
  }

  async #version(ownerId: string, documentId: string, versionId: string): Promise<VersionRow> {
    await getDocument(this.#d.db, ownerId, documentId);
    const v = await getVersion(this.#d.db, ownerId, versionId);
    if (!v || v.documentId !== documentId || v.status === "purged") throw new AppError("not_found", "版本不存在");
    return v;
  }

  async update(ownerId: string, id: string, patch: { title?: unknown; tags?: unknown }): Promise<DocumentRow> {
    const cur = await getDocument(this.#d.db, ownerId, id);
    const title = patch.title === undefined ? cur.title : cleanTitle(patch.title);
    if (title === undefined) throw new AppError("invalid_request", "title 不能为空", { issues: [{ path: "title" }] });
    const tags = patch.tags === undefined ? cur.tags : normalizeTags(patch.tags);
    await this.#d.db.run("UPDATE app_documents SET title = ?, tags_json = ?, updated_at = ? WHERE owner_id = ? AND id = ?", title, JSON.stringify(tags), this.#d.clock.now(), ownerId, id);
    return getDocument(this.#d.db, ownerId, id);
  }

  /** 停止使用（FR-KB-08，立即生效、可撤销）：同一个事务里把该资料所有片段置为不可检索。 */
  async revoke(ownerId: string, id: string): Promise<DocumentRow> {
    return this.#transition(ownerId, id, "ready", "revoked");
  }
  async restore(ownerId: string, id: string): Promise<DocumentRow> {
    return this.#transition(ownerId, id, "revoked", "ready");
  }
  async #transition(ownerId: string, id: string, from: "ready" | "revoked", to: "ready" | "revoked"): Promise<DocumentRow> {
    const now = this.#d.clock.now();
    return this.#d.db.transaction(async (tx) => {
      const cur = await getDocument(tx, ownerId, id);
      if (cur.status === to) return cur; // 幂等
      if (cur.status !== from) throw new AppError("invalid_request", `当前状态（${cur.status}）不能${to === "revoked" ? "停止使用" : "恢复"}`);
      await tx.run("UPDATE app_documents SET status = ?, revoked_at = ?, updated_at = ? WHERE owner_id = ? AND id = ?", to, to === "revoked" ? now : null, now, ownerId, id);
      await setActiveChunks(tx, ownerId, id, cur.currentVersionId, to === "ready"); // 立即生效：同一个事务里翻转片段的 active
      return getDocument(tx, ownerId, id);
    });
  }

  // ---- 作业处理器 --------------------------------------------------------------

  handlers(): Partial<Record<JobKind, JobHandler>> {
    return { ingest_text: (ctx) => this.#run(ctx, "text"), ingest_url: (ctx) => this.#run(ctx, "url") };
  }

  /** 作业到达终态时调用（JobWorker.onFinished）：失败则把资料标为 failed（已有可用版本的资料保持原状态）。 */
  async onJobFinished(job: JobRow): Promise<void> {
    if (job.status !== "failed" || (job.kind !== "ingest_url" && job.kind !== "ingest_text")) return;
    const documentId = (job.input as { documentId?: string }).documentId;
    if (!documentId) return;
    await this.#d.db.run(
      "UPDATE app_documents SET status = 'failed', error_code = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND status = 'pending'",
      job.errorCode ?? "internal",
      this.#d.clock.now(),
      job.ownerId,
      documentId,
    );
  }

  async #run(ctx: JobContext, mode: "text" | "url"): Promise<void> {
    const { job, checkpoint } = ctx;
    const ownerId = job.ownerId;
    const input = job.input as { documentId: string; url?: string };
    try {
      const doc = await getDocument(this.#d.db, ownerId, input.documentId).catch(() => undefined);
      if (!doc || doc.status === "purging") throw new JobError("not_found", "资料已不存在", false);

      // 阶段 1–2（仅 URL）：抓取 → 原始 blob → 版本记录
      let versionId = typeof checkpoint.versionId === "string" ? checkpoint.versionId : undefined;
      let contentType = typeof checkpoint.contentType === "string" ? checkpoint.contentType : undefined;
      if (mode === "url" && !versionId) {
        let rawHash = typeof checkpoint.raw === "string" ? checkpoint.raw : undefined;
        if (!rawHash || !this.#d.blobs.has(rawHash)) {
          const url = input.url!;
          await assertRobotsAllows(url, this.#d.fetchPolicy);
          const res = await safeFetch(url, this.#d.fetchPolicy);
          rawHash = this.#d.blobs.put(res.bytes);
          contentType = res.contentType ?? "";
          await ctx.save({ raw: rawHash, contentType });
          fault("job.after_fetch"); // 原文已写入 blob、版本记录尚未写入（R13）
        }
        const now = this.#d.clock.now();
        const v = await this.#d.db.transaction(async (tx) => {
          const existing = await findVersionByHash(tx, ownerId, doc.id, rawHash!);
          if (existing) return existing; // 崩溃重试或内容未变：不产生重复版本（UNIQUE 约束兜底）
          return insertVersion(tx, now, { documentId: doc.id, ownerId, contentHash: rawHash!, rawBlob: rawHash!, parserVersion: "pending" });
        });
        versionId = v.id;
        await ctx.save({ versionId });
      }
      if (!versionId) {
        // 文本类：版本在创建资料时已写入
        const v = (await listVersions(this.#d.db, ownerId, doc.id))[0];
        if (!v) throw new JobError("not_found", "版本不存在", false);
        versionId = v.id;
      }

      const version = (await getVersion(this.#d.db, ownerId, versionId))!;
      // 内容与某个已完成的版本相同（URL 重新采集到相同内容）：不改动，只确保它是当前版本
      if (version.status === "ready") {
        await this.#finish(ownerId, doc, version, undefined);
        return;
      }

      // 阶段 3：抽取正文
      let ex: Extracted | undefined;
      let textHash = version.textBlob ?? undefined;
      if (version.status === "parsing" || !textHash) {
        const bytes = this.#d.blobs.get(version.rawBlob);
        ex = this.#extract(doc, bytes, contentType);
        textHash = this.#d.blobs.put(ex.markdown);
        await this.#d.db.run(
          "UPDATE app_document_versions SET text_blob = ?, parser_version = ?, title = ?, char_count = ?, status = 'indexing' WHERE owner_id = ? AND id = ? AND status = 'parsing'",
          textHash,
          ex.parserVersion,
          ex.title || null,
          Array.from(ex.markdown).length,
          ownerId,
          versionId,
        );
        await ctx.save({ extracted: textHash });
      }

      // 阶段 4：索引（T-14），然后 ready
      const text = this.#d.blobs.getText(textHash!);
      if (this.#d.indexer) {
        await this.#d.indexer({ ownerId, documentId: doc.id, versionId, text });
        await this.#d.db.run(
          "UPDATE app_document_versions SET parser_version = parser_version || ? WHERE owner_id = ? AND id = ? AND parser_version NOT LIKE ?",
          `+${CHUNKER_VERSION}`,
          ownerId,
          versionId,
          `%+${CHUNKER_VERSION}`,
        );
      }
      const finalVersion = (await getVersion(this.#d.db, ownerId, versionId))!;
      await this.#finish(ownerId, doc, finalVersion, ex?.title ?? finalVersion.title ?? undefined);
    } catch (e) {
      throw this.#toJobError(e);
    }
  }

  #extract(doc: DocumentRow, bytes: Uint8Array, contentType: string | undefined): Extracted {
    try {
      if (doc.sourceType === "url") {
        const media = contentType?.split(";")[0]?.trim().toLowerCase() ?? "text/html";
        const { text } = decodeBody(bytes, contentType);
        if (media === "text/markdown") return extractPlain(text, "markdown");
        // 有些站点把 Markdown 以 text/plain 返回（带 front matter）：按 Markdown 处理，才能取到标题并剥掉 front matter
        // eslint-disable-next-line no-control-regex -- 有意剔除控制字符
        if (media === "text/plain") return extractPlain(text, new RegExp("^(?:\uFEFF)?---[ \t]*\r?\n").test(text) ? "markdown" : "text");
        return extractHtml(text, doc.sourceUri ?? undefined);
      }
      return extractPlain(new TextDecoder("utf-8").decode(bytes), doc.sourceType === "markdown" ? "markdown" : "text");
    } catch {
      throw new AppError("extract_failed", "无法解析该内容");
    }
  }

  /** 版本 ready，资料指向它；占位标题（等于 URL）在首次抽取后换成真实标题。 */
  async #finish(ownerId: string, doc: DocumentRow, version: VersionRow, extractedTitle: string | undefined): Promise<void> {
    const now = this.#d.clock.now();
    this.#log({ level: "info", event: "document.ready", document_id: doc.id, version_id: version.id });
    await this.#d.db.transaction(async (tx) => {
      await tx.run("UPDATE app_document_versions SET status = 'ready' WHERE owner_id = ? AND id = ? AND status IN ('parsing','indexing')", ownerId, version.id);
      const cur = await getDocument(tx, ownerId, doc.id);
      const placeholder = cur.sourceType === "url" && cur.title === cur.sourceUri;
      const title = placeholder && extractedTitle ? Array.from(extractedTitle).slice(0, MAX_TITLE_CHARS).join("") : cur.title;
      // revoked 的资料保持 revoked（用户的决定优先）；其余置为 ready
      const status = cur.status === "revoked" ? "revoked" : "ready";
      await tx.run(
        "UPDATE app_documents SET current_version_id = ?, status = ?, title = ?, error_code = NULL, updated_at = ? WHERE owner_id = ? AND id = ?",
        version.id,
        status,
        title,
        now,
        ownerId,
        doc.id,
      );
      await setActiveChunks(tx, ownerId, doc.id, version.id, status !== "revoked");
    });
  }

  #toJobError(e: unknown): unknown {
    if (e instanceof JobError) return e;
    if (e instanceof AppError) {
      const retryable = e.code === "fetch_timeout" || (e.code === "fetch_failed" && e.details.retryable === true);
      return new JobError(e.code, e.userMessage, retryable && !PERMANENT.has(e.code));
    }
    return e; // 其他异常由 JobWorker 按可重试的 internal 处理
  }
}
