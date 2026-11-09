import type { ConversationLookup } from "@durakeep/conversations";
import { AppError, fault, opKey, type Json } from "@durakeep/core";
import { once, type SqlDatabase } from "@durakeep/db";
import type { ReminderService } from "@durakeep/reminders";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { runAnchor } from "../runAnchor.ts";

export type ReminderToolDeps = { db: SqlDatabase; conversations: ConversationLookup; reminders: ReminderService };

const text = (s: string) => [{ type: "text" as const, text: s }];
const LOCAL = String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$`;

async function ownerOf(deps: ReminderToolDeps, conversationId: unknown): Promise<{ id: string; ownerId: string }> {
  const c = await deps.conversations.byPiId(String(conversationId));
  if (!c || c.archived) throw new Error("会话不可用");
  return { id: c.id, ownerId: c.ownerId };
}

/** AppReminders（05 §5）：reminder_create / reminder_update / reminder_cancel（写，once()，replay: safe）与 reminder_list（读）。 */
export function appRemindersExtension(deps: ReminderToolDeps) {
  /** 写工具模板：op_key = (会话, run 锚点, 工具名, 规范化参数)；业务写入与幂等记录在同一个事务里。 */
  async function write(toolName: string, api: { conversationId: unknown }, ctx: unknown, params: Json, run: (tx: Parameters<Parameters<typeof once>[5]>[0], conv: { id: string; ownerId: string }) => Promise<Json>) {
    const conv = await ownerOf(deps, api.conversationId);
    const anchor = await runAnchor(api, ctx);
    if (anchor === undefined) throw new Error("读不到 run 锚点");
    const key = opKey(conv.id, anchor, toolName, params);
    try {
      const { result, deduplicated } = await once(deps.db, conv.ownerId, key, toolName, params, (tx) => run(tx, conv));
      deps.reminders.onChange();
      fault("tool.after_business_commit");
      const body = { ...(result as Record<string, Json>), deduplicated };
      return { output: text(JSON.stringify(body)), details: body as never };
    } catch (e) {
      if (e instanceof AppError) return { output: text(e.userMessage), isError: true as const };
      throw e;
    }
  }
  const echo = (r: Awaited<ReturnType<ReminderService["get"]>>) => ({ ...deps.reminders.echo(r) }) as unknown as Json;

  const create = defineTool({
    name: "reminder_create",
    description:
      "为用户创建一次性提醒。local_datetime 是用户所在时区的完整本地时间 YYYY-MM-DDTHH:mm（以消息开头的 [当前时间] 为准换算，缺少日期或时间就先追问）。返回完整日期、星期和时区，请向用户复述确认。",
    parameters: obj({ text: str({ minLength: 1, maxLength: 200 }), local_datetime: str({ pattern: LOCAL }), timezone: str({ minLength: 1, maxLength: 64 }), document_id: opt(str({ minLength: 1, maxLength: 64 })) }),
    replay: "safe",
    callers: ["model"],
    execute: (args, api, ctx) =>
      write("reminder_create", api, ctx, { text: args.text, local_datetime: args.local_datetime, timezone: args.timezone, ...(args.document_id ? { document_id: args.document_id } : {}) }, async (tx, conv) =>
        echo(await deps.reminders.createTx(tx, conv.ownerId, { text: args.text, local_datetime: args.local_datetime, timezone: args.timezone, document_id: args.document_id, conversationId: conv.id })),
      ),
  });

  const list = defineTool({
    name: "reminder_list",
    description: "列出用户的提醒（可按状态过滤），含提醒 ID、完整本地时间与时区。",
    parameters: obj({ status: opt(oneOf(["active", "fired", "cancelled"] as const)) }),
    replay: "safe",
    callers: ["model"],
    execute: async (args, api) => {
      const { ownerId } = await ownerOf(deps, api.conversationId);
      const rows = await deps.reminders.list(ownerId, { status: args.status });
      const body = rows.length === 0 ? "没有提醒。" : rows.map((r) => { const e = deps.reminders.echo(r); return `- ${r.id}@${r.revision} [${r.status}] ${e.local}（${r.timezone}）${r.text}`; }).join("\n");
      return { output: text(body), details: { reminder_ids: rows.map((r) => r.id) } as never };
    },
  });

  const update = defineTool({
    name: "reminder_update",
    description: "修改一个提醒的时间或内容（只给需要改的字段）。修改后原来的时间不再触发。",
    parameters: obj({ reminder_id: str({ minLength: 1, maxLength: 64 }), local_datetime: opt(str({ pattern: LOCAL })), timezone: opt(str({ minLength: 1, maxLength: 64 })), text: opt(str({ minLength: 1, maxLength: 200 })) }),
    replay: "safe",
    callers: ["model"],
    execute: (args, api, ctx) =>
      write("reminder_update", api, ctx, { reminder_id: args.reminder_id, ...(args.local_datetime ? { local_datetime: args.local_datetime } : {}), ...(args.timezone ? { timezone: args.timezone } : {}), ...(args.text ? { text: args.text } : {}) }, async (tx, conv) =>
        echo(await deps.reminders.updateTx(tx, conv.ownerId, args.reminder_id, { text: args.text, local_datetime: args.local_datetime, timezone: args.timezone })),
      ),
  });

  const cancel = defineTool({
    name: "reminder_cancel",
    description: "取消一个提醒（已经取消的再取消不会出错）。",
    parameters: obj({ reminder_id: str({ minLength: 1, maxLength: 64 }) }),
    replay: "safe",
    callers: ["model"],
    execute: (args, api, ctx) => write("reminder_cancel", api, ctx, { reminder_id: args.reminder_id }, async (tx, conv) => echo(await deps.reminders.cancelTx(tx, conv.ownerId, args.reminder_id))),
  });

  return defineExtension({ name: "app-reminders", tools: [create, list, update, cancel] });
}
