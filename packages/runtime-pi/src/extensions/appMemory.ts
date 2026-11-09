import type { ConversationLookup } from "@durakeep/conversations";
import { AppError, fault, opKey, type Json } from "@durakeep/core";
import { once, type SqlDatabase } from "@durakeep/db";
import { normalizeKey, type MemoryRow, type MemoryService } from "@durakeep/memory";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { runAnchor } from "../runAnchor.ts";

export type MemoryToolDeps = { db: SqlDatabase; conversations: ConversationLookup; memory: MemoryService };

const text = (s: string) => [{ type: "text" as const, text: s }];

async function ownerOf(deps: MemoryToolDeps, conversationId: unknown): Promise<{ id: string; ownerId: string }> {
  const c = await deps.conversations.byPiId(String(conversationId));
  if (!c || c.archived) throw new Error("会话不可用");
  return { id: c.id, ownerId: c.ownerId };
}

const line = (m: MemoryRow) => `- ${m.id}@${m.revision} [${m.scope}] ${m.key}：${m.value}`;

/** AppMemory（05 §5）：memory_search（读）、memory_remember（写，走 once()，replay: safe）。owner 一律由会话映射得出。 */
export function appMemoryExtension(deps: MemoryToolDeps) {
  const search = defineTool({
    name: "memory_search",
    description: "检索用户已确认的长期记忆（偏好、个人事实、项目背景）。结果带 memory_id@revision。",
    parameters: obj({ query: str({ minLength: 1, maxLength: 200 }), scope: opt(str({ minLength: 1, maxLength: 60 })) }),
    replay: "safe",
    callers: ["model"],
    execute: async (args, api) => {
      const { ownerId } = await ownerOf(deps, api.conversationId);
      const rows = await deps.memory.search(ownerId, args.query, args.scope);
      const body = rows.length === 0 ? "没有找到相关的已确认记忆。" : rows.map(line).join("\n");
      return { output: text(body), details: { memory_ids: rows.map((r) => `${r.id}@${r.revision}`) } as never };
    },
  });

  const remember = defineTool({
    name: "memory_remember",
    description:
      "保存一条长期记忆。只有用户明确说“记住……”时才调用；假设、举例、转述他人的话都不算。key 形如 review.verbosity；同一作用范围内同一个 key 写入新值会取代旧值。",
    parameters: obj({
      kind: oneOf(["preference", "profile_fact", "project_context"] as const),
      key: str({ minLength: 1, maxLength: 64 }),
      value: str({ minLength: 1, maxLength: 200 }),
      scope: opt(str({ minLength: 1, maxLength: 60 })),
    }),
    replay: "safe",
    callers: ["model"],
    execute: async (args, api, ctx) => {
      const conv = await ownerOf(deps, api.conversationId);
      const anchor = await runAnchor(api, ctx);
      if (anchor === undefined) throw new Error("读不到 run 锚点");
      const scope = args.scope ?? "global";
      const params = { kind: args.kind, key: normalizeKey(args.key), value: args.value.trim(), scope } satisfies Json;
      const key = opKey(conv.id, anchor, "memory_remember", params);
      try {
        const { result, deduplicated } = await once(deps.db, conv.ownerId, key, "memory_remember", params, async (tx) => {
          const r = await deps.memory.rememberTx(tx, conv.ownerId, { ...params, source: { kind: "message", conversation_id: conv.id }, changedBy: "tool" });
          return { memory_id: r.memoryId, revision: r.revision, superseded_value: r.supersededValue, unchanged: r.unchanged } satisfies Json;
        });
        fault("tool.after_business_commit");
        const r = result as { memory_id: string; revision: number; superseded_value: string | null; unchanged: boolean };
        const body = {
          ...r,
          deduplicated,
          message: r.unchanged ? "这条记忆已经存在" : `已记住：${params.key} = ${params.value}（作用范围 ${scope}）${r.superseded_value ? `；取代了旧值“${r.superseded_value}”` : ""}`,
        };
        return { output: text(JSON.stringify(body)), details: body as never };
      } catch (e) {
        if (e instanceof AppError) return { output: text(e.userMessage), isError: true as const };
        throw e;
      }
    },
  });

  return defineExtension({ name: "app-memory", tools: [search, remember] });
}
