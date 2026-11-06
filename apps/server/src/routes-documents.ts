import { AppError, type Clock } from "@durakeep/core";
import type { SqlDatabase } from "@durakeep/db";
import { cancelJob, getJob, listJobs, retryJob, type JobRow, type JobStatus } from "@durakeep/jobs";
import { MAX_UPLOAD_BYTES, type DocumentRow, type KnowledgeService, type VersionRow } from "@durakeep/knowledge";
import type { Hono } from "hono";
import type { AppEnv } from "./app.ts";
import { parseLimit, readJson } from "./http.ts";
import type { RateLimiter } from "./rateLimit.ts";

const presentDoc = (d: DocumentRow) => ({
  id: d.id,
  source_type: d.sourceType,
  source_uri: d.sourceUri,
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
const UPLOAD_EXT: Record<string, "markdown" | "text"> = { ".md": "markdown", ".markdown": "markdown", ".txt": "text" };

/** 文件名只用于生成默认标题：去掉路径与控制字符；永远不参与任何文件路径（S12）。 */
export function titleFromFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex -- 有意剔除控制字符
  return base.replace(/\.[^.]*$/, "").replace(/[\u0000-\u001F\u007F]/g, " ").trim();
}

export function mountDocumentRoutes(
  app: Hono<AppEnv>,
  deps: { db: SqlDatabase; clock: Clock; limits?: Partial<Record<"capture", number>>; wake?: () => void },
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
      const kind = UPLOAD_EXT[ext];
      if (!kind) throw new AppError("unsupported_type", "只支持 .md、.markdown 和 .txt 文件");
      if (file.size > MAX_UPLOAD_BYTES) throw new AppError("too_large", "文件不能超过 2 MB");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(await file.arrayBuffer()));
      } catch {
        throw new AppError("invalid_request", "文件需为 UTF-8 编码");
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
        // 标题优先级：文档自己的 # 标题 > 文件名（只当标题用）> 首行文字（由 captureText 兜底）
        title: (kind === "markdown" && /^#{1,6}\s+\S/m.test(text) ? undefined : titleFromFilename(file.name)) || undefined,
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
    const body = (await readJson(c)) as { title?: unknown; tags?: unknown } | null;
    return c.json(presentDoc(await knowledge.update(c.get("owner").id, c.req.param("id"), body ?? {})));
  });
  app.post("/v1/documents/:id/revoke", async (c) => c.json(presentDoc(await knowledge.revoke(c.get("owner").id, c.req.param("id")))));
  app.post("/v1/documents/:id/restore", async (c) => c.json(presentDoc(await knowledge.restore(c.get("owner").id, c.req.param("id")))));

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
