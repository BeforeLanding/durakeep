// 测试替身的再导出：测试代码不直接 import @earendil-works（ADR-01）。
export { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { fauxAssistantMessage as msg, fauxProvider as provider } from "@earendil-works/pi-ai/providers/faux";

/** test / demo 模式下服务进程使用的 faux：固定回复，零费用。 */
export function demoFaux() {
  const faux = provider();
  faux.setResponses(Array.from({ length: 10_000 }, () => () => msg("这是演示模式的回复。")));
  return faux;
}

/**
 * demo 模式的脚本化 faux：用户消息 → 先调用 kb_search（查询取用户原话）→ 拿到结果后依据第一个片段作答并带引用；
 * 没有命中时直接说明。零费用，行为确定。
 */
export function demoScriptedFaux() {
  const faux = provider();
  const step = (ctx: { messages: { role: string; content?: unknown }[] }) => {
    const last = ctx.messages[ctx.messages.length - 1];
    const text = Array.isArray(last?.content)
      ? (last.content as { text?: string }[]).map((p) => p.text ?? "").join("")
      : String(last?.content ?? "");
    if (last?.role === "toolResult") {
      const m = /<source id="chunk:(\d+)"/.exec(text);
      if (!m) return msg("资料里没有找到相关内容。可以先在“资料”页收藏一些，或者换个问法。");
      const inner = />\n([\s\S]*?)\n<\/source>/.exec(text)?.[1] ?? "";
      const body = inner.split("\n").find((l) => l.trim() !== "" && !l.startsWith("#"))?.slice(0, 80) ?? "";
      return msg(`根据你收藏的资料：${body}… [1]\n<citations>\n[1] chunk:${m[1]}\n</citations>`);
    }
    const q = text.replace(/^\[当前时间[^\]]*\]\n?/, "").trim() || "资料";
    return msg(toolCall("kb_search", { query: q, top_k: 4 }), { stopReason: "toolUse" });
  };
  faux.setResponses(Array.from({ length: 10_000 }, () => (ctx) => step(ctx as never)));
  return faux;
}
import { fauxToolCall as toolCall } from "@earendil-works/pi-ai/providers/faux";
