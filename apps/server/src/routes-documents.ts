import { AppError, type Clock } from "@durakeep/core";
import type { SqlDatabase } from "@durakeep/db";
import { cancelJob, getJob, listJobs, retryJob, type JobRow, type JobStatus } from "@durakeep/jobs";
import { docxToMarkdown, extractHtml, pdfToMarkdown, MAX_UPLOAD_BYTES, type KnowledgeRetrieval, type DocumentRow, type KnowledgeService, type VersionRow } from "@durakeep/knowledge";
import type { Hono } from "hono";
import type { AppEnv } from "./app.ts";
import { parseLimit, readJson } from "./http.ts";
import type { RateLimiter } from "./rateLimit.ts";
import { buildExport } from "./export.ts";

const presentDoc = (d: DocumentRow) => ({
  id: d.id,
  source_type: d.sourceType,
  source_uri: d.sourceUri,
  source_format: d.sourceFormat,
  title: d.title,
  status: d.status,
  tags: d.tags,
  created_at: d.createdAt,
  updated_at: d.updatedAt,
  error_code: d.errorCode,
});
const presentVersion = (v: VersionRow, current: string | null) => ({
  id: v.id,
  captured_at: v.capturedAt,
  status: v.status,
  char_count: v.charCount,
  parser_version: v.parserVersion,
  summary: v.summary,
  summary_edited: v.summaryEdited,
  current: v.id === current,
});
export const presentJob = (j: JobRow) => ({
  id: j.id,
  kind: j.kind,
  status: j.status,
  attempts: j.attempts,
  max_attempts: j.maxAttempts,
  next_attempt_at: j.status === "queued" ? j.nextAttemptAt : null,
  error_code: j.errorCode,
  error_message: j.errorMessage,
  document_id: (j.input as { documentId?: string }).documentId ?? null,
  created_at: j.createdAt,
  updated_at: j.updatedAt,
});

const JOB_STATUSES = new Set<JobStatus>(["queued", "running", "succeeded", "failed", "cancelled"]);
type UploadKind = "markdown" | "text" | "html" | "docx" | "pdf";
const UPLOAD_EXT: Record<string, UploadKind> = {
  ".md": "markdown", ".markdown": "markdown", ".txt": "text", ".html": "html", ".htm": "html", ".docx": "docx", ".pdf": "pdf",
};
/** Word 文件常带图片，体积大但文字少，单独放宽到 10 MB；PDF 20 MB；文本类仍是 2 MB。 */
export const MAX_DOCX_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
const LIMIT: Record<UploadKind, [number, string]> = {
  docx: [MAX_DOCX_BYTES, "Word 文件不能超过 10 MB"],
  pdf: [MAX_PDF_BYTES, "PDF 文件不能超过 20 MB"],
  markdown: [MAX_UPLOAD_BYTES, "文件不能超过 2 MB"],
  text: [MAX_UPLOAD_BYTES, "文件不能超过 2 MB"],
  html: [MAX_UPLOAD_BYTES, "文件不能超过 2 MB"],
};

/** 文本文件：先按 UTF-8 严格解码，失败再按 GB18030（Windows 下常见的 GBK 文本）解码。 */
function decodeTextFile(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("gb18030", { fatal: true }).decode(bytes);
    } catch {
      throw new AppError("invalid_request", "无法识别文件编码，请另存为 UTF-8 后再上传");
    }
  }
}

/** 文件名只用于生成默认标题：去掉路径与控制字符；永远不参与任何文件路径（S12）。 */
export function titleFromFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex -- 有意剔除控制字符
  return base.replace(/\.[^.]*$/, "").replace(/[\u0000-\u001F\u007F]/g, " ").trim();
}

export function mountDocumentRoutes(
  app: Hono<AppEnv>,
  deps: { db: SqlDatabase; clock: Clock; limits?: Partial<Record<"capture", number>>; wake?: () => void; retrieval?: KnowledgeRetrieval },
  knowledge: KnowledgeService,
  limiter: RateLimiter,
  captureLimit: number,
) {
  const capture = (ownerId: string) => {
    const wait = limiter.hit(`capture:${ownerId}`, deps.limits?.capture ?? captureLimit);
    if (wait !== undefined) throw new AppError("rate_limited", "采集过于频繁", { retry_after_ms: wait });
  };

  app.get("/v1/documents", async (c) => {
    const q = c.req.query();
    const page = await knowledge.list(c.get("owner").id, {
      status: q.status,
      tag: q.tag,
      q: q.q,
      limit: parseLimit(q.limit),
      cursor: q.cursor,
    });
    return c.json({ items: page.items.map(presentDoc), next_cursor: page.nextCursor });
  });

  app.post("/v1/documents", async (c) => {
    const owner = c.get("owner");
    capture(owner.id);
    const contentType = c.req.header("content-type") ?? "";
    let r;
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      const form = await c.req.parseBody().catch(() => {
        throw new AppError("invalid_request", "multipart 请求体无效");
      });
      const file = form.file;
      if (!(file instanceof File)) throw new AppError("invalid_request", "缺少 file 字段", { issues: [{ path: "file" }] });
      const ext = /\.[^./\\]+$/.exec(file.name)?.[0]?.toLowerCase() ?? "";
      const uploadKind = UPLOAD_EXT[ext];
      if (!uploadKind) throw new AppError("unsupported_type", "支持 PDF、Word（.docx）、Markdown、纯文本和网页（.html）文件");
      if (file.size > LIMIT[uploadKind][0]) throw new AppError("too_large", LIMIT[uploadKind][1]);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let text: string;
      let kind: "markdown" | "text" = uploadKind === "text" ? "text" : "markdown";
      let ownTitle: string | undefined;
      if (uploadKind === "pdf") {
        const md = await pdfToMarkdown(bytes);
        text = md.markdown;
        ownTitle = titleFromFilename(file.name) || md.title;
      } else if (uploadKind === "docx") {
        const md = docxToMarkdown(bytes);
        text = md.markdown;
        ownTitle = titleFromFilename(file.name) || md.title; // Word：文件名通常就是文档标题（飞书导出亦然）
      } else if (uploadKind === "html") {
        const ex = extractHtml(decodeTextFile(bytes));
        text = ex.markdown;
        ownTitle = ex.title || undefined;
        kind = "markdown";
      } else {
        text = decodeTextFile(bytes);
        // Markdown 自带 # 标题时交给 captureText 从正文取；否则用文件名
        if (!(kind === "markdown" && /^#{1,6}\s+\S/m.test(text))) ownTitle = titleFromFilename(file.name);
      }
      let tags: unknown;
      if (typeof form.tags === "string" && form.tags !== "") {
        try {
          tags = JSON.parse(form.tags);
        } catch {
          throw new AppError("invalid_request", "tags 必须是 JSON 数组字符串", { issues: [{ path: "tags" }] });
        }
      }
      r = await knowledge.captureText(owner.id, {
        clientRequestId: form.client_request_id as string,
        kind,
        ...(uploadKind === "pdf" || uploadKind === "docx" || uploadKind === "html" ? { format: uploadKind } : {}),
        // 标题优先级：文档自己的标题 > 文件名（只当标题用）> 首行文字（由 captureText 兜底）
        title: ownTitle || (uploadKind === "html" ? titleFromFilename(file.name) : undefined) || undefined,
        text,
        tags,
      });
    } else {
      const body = (await readJson(c)) as Record<string, unknown> | null;
      if (!body || typeof body !== "object") throw new AppError("invalid_request", "请求体需为 JSON 对象");
      const type = body.type;
      if (type === "url") {
        r = await knowledge.captureUrl(owner.id, { clientRequestId: body.client_request_id as string, url: body.url as string, tags: body.tags });
      } else if (type === "text" || type === "markdown") {
        r = await knowledge.captureText(owner.id, {
          clientRequestId: body.client_request_id as string,
          kind: type,
          title: body.title as string | undefined,
          text: body.text as string,
          tags: body.tags,
        });
      } else {
        throw new AppError("invalid_request", "type 需为 url、text 或 markdown", { issues: [{ path: "type" }] });
      }
    }
    return c.json({ document_id: r.documentId, job_id: r.jobId, status: r.status, deduplicated: r.deduplicated }, r.deduplicated ? 200 : 202);
  });

  app.post("/v1/documents/:id/refresh", async (c) => {
    const owner = c.get("owner");
    capture(owner.id);
    const r = await knowledge.refresh(owner.id, c.req.param("id"));
    return c.json({ job_id: r.jobId, created: r.created }, r.created ? 202 : 200);
  });

  // 06 §4：资料页全文搜索，与 kb_search 同一条检索链路
  const retrieval = deps.retrieval;
  if (retrieval) app.get("/v1/search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (q === "" || Array.from(q).length > 200) throw new AppError("invalid_request", "q 需为 1–200 个字符", { issues: [{ path: "q" }] });
    const topK = parseLimit(c.req.query("top_k"), 20) ?? 10;
    return c.json({ items: await retrieval.searchForUi(c.get("owner").id, { query: q, topK }) });
  });

  app.get("/v1/documents/:id", async (c) => {
    const { document, versions } = await knowledge.detail(c.get("owner").id, c.req.param("id"));
    return c.json({ ...presentDoc(document), versions: versions.map((v) => presentVersion(v, document.currentVersionId)) });
  });

  app.get("/v1/documents/:id/versions/:vid/text", async (c) => {
    const text = await knowledge.readText(c.get("owner").id, c.req.param("id"), c.req.param("vid"));
    return c.body(text, 200, { "Content-Type": "text/markdown; charset=utf-8", "X-Content-Type-Options": "nosniff" });
  });

  // 原始内容一律以附件方式返回，不在页面中渲染（HTML 可能含脚本）；文件名由 ID 生成，不用标题或来源文件名
  app.get("/v1/documents/:id/versions/:vid/raw", async (c) => {
    const { bytes, document } = await knowledge.readRaw(c.get("owner").id, c.req.param("id"), c.req.param("vid"));
    const ext = document.sourceType === "url" ? "html" : document.sourceType === "markdown" ? "md" : "txt";
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${document.id}-${c.req.param("vid")}.${ext}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    });
  });

  app.patch("/v1/documents/:id", async (c) => {
    const body = (await readJson(c)) as { title?: unknown; tags?: unknown; summary?: unknown } | null;
    return c.json(presentDoc(await knowledge.update(c.get("owner").id, c.req.param("id"), body ?? {})));
  });
  // 彻底删除（FR-KB-08）：立即不可检索，其余异步
  app.delete("/v1/documents/:id", async (c) => {
    const r = await knowledge.purge(c.get("owner").id, c.req.param("id"));
    return c.json({ document_id: r.documentId, job_id: r.jobId }, 202);
  });
  // 引用过这份资料的会话（彻底删除前列出，用户可以归档它们）
  app.get("/v1/documents/:id/conversations", async (c) => {
    const ownerId = c.get("owner").id;
    await knowledge.detail(ownerId, c.req.param("id")); // 不存在 / 别人的 → 404
    const list = await knowledge.referencingConversations(ownerId, c.req.param("id"));
    return c.json({ items: list.map((x) => ({ id: x.id, title: x.title, archived: x.archived, last_active_at: x.lastActiveAt })) });
  });
  app.post("/v1/documents/:id/revoke", async (c) => c.json(presentDoc(await knowledge.revoke(c.get("owner").id, c.req.param("id")))));
  app.post("/v1/documents/:id/restore", async (c) => c.json(presentDoc(await knowledge.restore(c.get("owner").id, c.req.param("id")))));

  // 引用悬停（06 §4）：返回片段文本与出处；owner 与 active 都校验，否则一律 404
  app.get("/v1/chunks/:id", async (c) => {
    const id = c.req.param("id");
    const row = /^\d+$/.test(id)
      ? await deps.db.get<{ id: number; document_id: string; version_id: string; heading_path: string; char_start: number; char_end: number; text: string; title: string }>(
          `SELECT k.id, k.document_id, k.version_id, k.heading_path, k.char_start, k.char_end, k.text, d.title
             FROM app_chunks k JOIN app_documents d ON d.id = k.document_id AND d.owner_id = k.owner_id
            WHERE k.owner_id = ? AND k.id = ? AND k.active = 1`,
          c.get("owner").id,
          Number(id),
        )
      : undefined;
    if (!row) throw new AppError("not_found", "资源不存在");
    return c.json({
      id: row.id,
      document_id: row.document_id,
      version_id: row.version_id,
      title: row.title,
      loc: row.heading_path,
      char_start: row.char_start,
      char_end: row.char_end,
      text: row.text,
    });
  });

  // 导出（06 §7、04 §6）：zip，不含口令哈希、会话、幂等记录、事件与 pi_*
  app.get("/v1/export", async (c) => {
    const now = deps.clock.now();
    const zip = await buildExport(deps.db, knowledge, c.get("owner"), now);
    const stamp = new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 15);
    return c.body(new Uint8Array(zip), 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="export-${stamp}.zip"`,
      "X-Content-Type-Options": "nosniff",
    });
  });

  // 作业（06 §7）
  app.get("/v1/jobs", async (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !JOB_STATUSES.has(status as JobStatus)) {
      throw new AppError("invalid_request", "status 无效", { issues: [{ path: "status" }] });
    }
    const items = await listJobs(deps.db, c.get("owner").id, { status: status as JobStatus | undefined, limit: parseLimit(c.req.query("limit")) });
    return c.json({ items: items.map(presentJob) });
  });
  app.get("/v1/jobs/:id", async (c) => c.json(presentJob(await getJob(deps.db, c.get("owner").id, c.req.param("id")))));
  app.post("/v1/jobs/:id/retry", async (c) => {
    const j = await retryJob(deps.db, deps.clock.now(), c.get("owner").id, c.req.param("id"));
    deps.wake?.();
    return c.json(presentJob(j));
  });
  app.post("/v1/jobs/:id/cancel", async (c) => c.json(presentJob(await cancelJob(deps.db, deps.clock.now(), c.get("owner").id, c.req.param("id")))));
}
