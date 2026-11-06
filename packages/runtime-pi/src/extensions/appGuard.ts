import type { ConversationLookup } from "@durakeep/conversations";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

/** 模型可以调用的工具白名单（纵深防御：即使别的扩展意外注册了工具，也不会被执行）。新增工具要在 05 §5 登记并加进这里。 */
export const TOOL_ALLOWLIST: ReadonlySet<string> = new Set(["kb_search", "kb_get_source", "kb_list_documents", "kb_capture_text", "kb_capture_url"]);

/**
 * AppGuard（05 §4.3）：beforeTool 里按 Pi 会话 ID 找到业务会话；找不到或已归档就拒绝；工具名不在白名单也拒绝。
 * 日志只记 ID 与状态（AGENTS.md 硬规则 9）。
 */
export function appGuardExtension(deps: { conversations: ConversationLookup; allow?: ReadonlySet<string> }) {
  const allow = deps.allow ?? TOOL_ALLOWLIST;
  return defineExtension({
    name: "app-guard",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api) => {
          if (!allow.has(call.name)) return { block: "该工具不可用" };
          const conv = await deps.conversations.byPiId(String(api.conversationId));
          if (!conv || conv.archived) return { block: "会话不可用" };
          return undefined;
        },
      }),
    ],
  });
}
