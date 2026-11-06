import type { ConversationLookup } from "@durakeep/conversations";
import { AppError, fault, normalizeText, opKey, type Json } from "@durakeep/core";
import { once, type SqlDatabase } from "@durakeep/db";
import type { KnowledgeRetrieval, KnowledgeService, ToolText } from "@durakeep/knowledge";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { arr, int, obj, opt, str } from "@earendil-works/pi-schema";
import { runAnchor } from "../runAnchor.ts";

export type KnowledgeToolDeps = {
  /** 已用 guardDb 包装的业务连接。 */
  db: SqlDatabase;
  conversations: ConversationLookup;
  knowledge: KnowledgeService;
  retrieval: KnowledgeRetrieval;
};

const text = (s: string) => [{ type: "text" as const, text: s }];
const fromToolText = (r: ToolText) => ({ output: text(r.text), details: r.details as never, ...(r.isError ? { isError: true } : {}) });
const tagsParam = () => opt(arr(str({ minLength: 1, maxLength: 32 }), { maxItems: 10 }));

/** 工具参数里不接受 owner：owner 一律由服务端按会话映射取得（AGENTS.md 硬规则 4）。 */
async function ownerOf(deps: KnowledgeToolDeps, conversationId: unknown): Promise<{ id: string; ownerId: string }> {
  const c = await deps.conversations.byPiId(String(conversationId));
  if (!c || c.archived) throw new Error("会话不可用");
  return { id: c.id, ownerId: c.ownerId };
}

/** AppKnowledge（05 §5）：3 个只读工具 + 2 个写工具。写工具走 operations.once() 并声明 replay: "safe"（ADR-04）。 */
export function appKnowledgeExtension(deps: KnowledgeToolDeps) {
  const kbSearch = defineTool({
    name: "kb_search",
    description: "在用户收藏的资料里检索。返回若干 <source> 片段（带 chunk id、标题、位置）。回答涉及用户资料之前先调用它。",
    parameters: obj({
      query: str({ minLength: 1, maxLength: 200 }),
      top_k: opt(int({ minimum: 1, maximum: 10 })),
      tags: tagsParam(),
    }),
    replay: "safe",
    callers: ["model"],
    execute: async (args, api) => {
      const { ownerId } = await ownerOf(deps, api.conversationId);
      const r = await deps.retrieval.search(ownerId, { query: normalizeText(args.query), topK: args.top_k, tags: args.tags });
      return fromToolText(r);
    },
  });

  const kbGetSource = defineTool({
    name: "kb_get_source",
    description: "取得某个片段的原文，以及它前后各 expand 个相邻片段（0–2），用于补充上下文。",
    parameters: obj({ chunk_id: int({ minimum: 1 }), expand: opt(int({ minimum: 0, maximum: 2 })) }),
    replay: "safe",
    callers: ["model"],
    execute: async (args, api) => {
      const { ownerId } = await ownerOf(deps, api.conversationId);
      return fromToolText(await deps.retrieval.getSource(ownerId, args.chunk_id, args.expand ?? 0));
    },
  });

  const kbList = defineTool({
    name: "kb_list_documents",
    description: "列出用户收藏的资料（标题、ID、状态），可按标签过滤。",
    parameters: obj({ tag: opt(str({ minLength: 1, maxLength: 32 })), limit: opt(int({ minimum: 1, maximum: 20 })) }),
    replay: "safe",
    callers: ["model"],
    execute: async (args, api) => {
      const { ownerId } = await ownerOf(deps, api.conversationId);
      return fromToolText(await deps.retrieval.listDocuments(ownerId, { tag: args.tag, limit: args.limit }));
    },
  });

  /** 写工具模板（05 §5.2）：op_key = (会话, run 锚点, 工具名, 规范化参数)；业务写入与幂等记录在同一个事务里。 */
  async function capture(
    toolName: "kb_capture_text" | "kb_capture_url",
    api: { conversationId: unknown },
    ctx: unknown,
    plan: (ownerId: string) => ReturnType<KnowledgeService["planCaptureText"]>,
    receipt: (r: { documentId: string; jobId: string | null; status: string; deduplicated: boolean }) => Json,
  ) {
    const conv = await ownerOf(deps, api.conversationId);
    const anchor = await runAnchor(api, ctx);
    if (anchor === undefined) throw new Error("读不到 run 锚点");
    let p: ReturnType<KnowledgeService["planCaptureText"]>;
    try {
      p = plan(conv.ownerId);
    } catch (e) {
      if (e instanceof AppError) return { output: text(e.userMessage), isError: true as const };
      throw e;
    }
    const key = opKey(conv.id, anchor, toolName, p.args);
    try {
      const { result, deduplicated } = await once(deps.db, conv.ownerId, key, toolName, p.args, p.run as never);
      deps.knowledge.wake(); // 作业入队之后唤醒队列
      fault("tool.after_business_commit"); // 业务已提交、结果尚未交给 Pi（R2）
      const body = receipt({ ...(result as { documentId: string; jobId: string | null; status: string; deduplicated: boolean }), deduplicated: deduplicated || (result as { deduplicated: boolean }).deduplicated });
      return { output: text(JSON.stringify(body)), details: body as never };
    } catch (e) {
      if (e instanceof AppError) return { output: text(e.userMessage), isError: true as const };
      throw e;
    }
  }

  const kbCaptureText = defineTool({
    name: "kb_capture_text",
    description: "把一段文字收藏进用户的资料库（用户明确要求保存时才调用）。收藏后在后台处理，完成后即可检索。",
    parameters: obj({
      title: str({ minLength: 1, maxLength: 120 }),
      text: str({ minLength: 1, maxLength: 100_000 }),
      tags: tagsParam(),
    }),
    replay: "safe",
    callers: ["model"],
    execute: (args, api, ctx) =>
      capture(
        "kb_capture_text",
        api,
        ctx,
        (ownerId) => deps.knowledge.planCaptureText(ownerId, { kind: "text", title: normalizeText(args.title), text: args.text, tags: args.tags }),
        (r) => ({ document_id: r.documentId, status: r.status, deduplicated: r.deduplicated, message: r.deduplicated ? "这份内容之前已经收藏过" : "已收藏，后台处理完成后即可检索" }),
      ),
  });

  const kbCaptureUrl = defineTool({
    name: "kb_capture_url",
    description: "收藏一个网页链接（用户明确要求保存时才调用）。抓取在后台进行，不会立刻可检索。",
    parameters: obj({ url: str({ minLength: 1, maxLength: 2000 }), tags: tagsParam() }),
    replay: "safe",
    callers: ["model"],
    execute: (args, api, ctx) =>
      capture(
        "kb_capture_url",
        api,
        ctx,
        (ownerId) => deps.knowledge.planCaptureUrl(ownerId, { url: args.url, tags: args.tags }),
        (r) => ({ document_id: r.documentId, job_id: r.jobId, status: "queued", deduplicated: r.deduplicated, message: r.deduplicated ? "这个链接今天已经在处理了" : "已排队抓取，完成后即可检索" }),
      ),
  });

  return defineExtension({ name: "app-knowledge", tools: [kbSearch, kbGetSource, kbList, kbCaptureText, kbCaptureUrl] });
}
