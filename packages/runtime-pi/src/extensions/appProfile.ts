import type { ConversationLookup } from "@durakeep/conversations";
import type { MemoryService } from "@durakeep/memory";
import { defineExtension, section } from "@earendil-works/pi-durable";

export const PROFILE_LIMIT = 20;

/**
 * AppProfile（05 §4.2，ADR-05）：把 scope=global 的已确认记忆渲染成 <profile> section。
 * 每次请求都会重新渲染，所以按 memory_set_revision 缓存：版本号不变就返回同一个字符串（文本不变就不会追加 pi.system）。
 * 没有记忆时返回 undefined（省略 section）。owner 由会话映射取得，不接受任何参数。
 */
export function appProfileExtension(deps: { conversations: ConversationLookup; memory: MemoryService }) {
  const cache = new Map<string, { revision: number; text: string | undefined }>();
  return defineExtension({
    name: "app-profile",
    sections: [
      section("profile", async (input) => {
        const conv = await deps.conversations.byPiId(String(input.conversationId));
        if (!conv) return undefined;
        const revision = await deps.memory.setRevision(conv.ownerId);
        const hit = cache.get(conv.ownerId);
        if (hit && hit.revision === revision) return hit.text;
        const rows = await deps.memory.globalConfirmed(conv.ownerId, PROFILE_LIMIT);
        const text =
          rows.length === 0 ? undefined : `以下是用户确认过的长期偏好。用户当次的明确要求优先于这些偏好：\n${rows.map((m) => `- [${m.key}] ${m.value}`).join("\n")}`;
        cache.set(conv.ownerId, { revision, text });
        return text;
      }),
    ],
  });
}
