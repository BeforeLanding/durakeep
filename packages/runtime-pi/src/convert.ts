// Pi 条目 → 应用视图 AppEntry（05 §7 的转换规则）。纯函数，不触碰存储。
import { parseAnswer, stripCitationsForDisplay, type AppEntry, type ConversationSnapshot, type Json, type RunFailureReason } from "@durakeep/core";

type Block = { type?: string; text?: string };
type ModelMessage = { role?: string; content?: unknown; toolName?: string; isError?: boolean };
export type PiEntryLike = { id: number; kind: string; data?: unknown; model?: readonly unknown[] };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/** 返回 undefined 表示该条目不展示（如 pi.system）。 */
export function toAppEntry(e: PiEntryLike): AppEntry | undefined {
  const id = String(e.id);
  const msg = e.model?.[0] as ModelMessage | undefined;
  switch (e.kind) {
    case "app.user": {
      const d = (e.data ?? {}) as { text?: string; at?: number; tz?: string };
      return { id, kind: "user", text: d.text ?? "", ...(d.at !== undefined ? { at: d.at } : {}), ...(d.tz ? { tz: d.tz } : {}) };
    }
    case "pi.user":
      return { id, kind: "user", text: textOf(msg?.content) };
    case "pi.assistant": {
      const p = parseAnswer(textOf(msg?.content));
      return { id, kind: "assistant", text: p.text, ...(p.citations.length > 0 || p.markers.length > 0 ? { citations: p.citations, markers: p.markers } : {}) };
    }
    case "pi.tool-result":
      return { id, kind: "tool", name: msg?.toolName ?? "?", ok: msg?.isError !== true };
    case "pi.compaction":
      return { id, kind: "compaction" };
    case "pi.system":
    case "pi.reset":
      return undefined;
    default:
      if (e.kind.startsWith("app.")) return { id, kind: "event", eventKind: e.kind, data: (e.data ?? null) as Json };
      return undefined;
  }
}

type LiveLike = {
  run?: unknown;
  generation?: { message?: { content?: unknown } };
  runFailure?: { reason: RunFailureReason; detail?: unknown };
  tools?: { callId: string; name: string; status: "pending" | "running" | "done"; diagnostics?: unknown[] }[];
};

export function toSnapshotLive(docs: Readonly<Record<string, unknown>>): ConversationSnapshot["live"] {
  const live = (docs["pi.live"] ?? {}) as LiveLike;
  const inbox = (docs["pi.inbox"] ?? {}) as { items?: unknown[] };
  const partial = stripCitationsForDisplay(textOf(live.generation?.message?.content));
  return {
    running: live.run !== undefined,
    ...(partial !== "" ? { partialText: partial } : {}),
    tools: (live.tools ?? []).map((t) => ({
      callId: t.callId,
      name: t.name,
      status: t.status === "done" ? ((t.diagnostics?.length ?? 0) > 0 ? "error" : "done") : "running",
    })),
    ...(live.runFailure
      ? { runFailure: { reason: live.runFailure.reason, ...(typeof live.runFailure.detail === "string" ? { detail: live.runFailure.detail } : {}) } }
      : {}),
    queued: (inbox.items ?? []).length,
  };
}

/** 产出 chunk id 的工具：它们的 details.chunk_ids 就是“这次 run 里模型见过的片段”。 */
export const SOURCE_TOOLS: ReadonlySet<string> = new Set(["kb_search", "kb_get_source"]);

/**
 * 从某条助手条目往前回溯（entriesDescending：从它的前一条开始，ID 递减），收集同一次 run 里 kb_search / kb_get_source
 * 的结果里出现过的 chunk id。run 的边界 = 上一条“不是在调用工具”的助手条目（stopReason 不是 toolUse）：
 * 追问（followUp）在上一个回答之后才开始，所以属于新的 run；插话（steer）发生在 run 内部，不会截断。
 * 以 details 为准而不是输出文本：details 由工具写入，不受资料内容影响。返回 true 表示已经碰到上一个 run 的结尾。
 */
export function collectRunChunkIds(entriesDescending: readonly PiEntryLike[], into: Set<number>): boolean {
  for (const e of entriesDescending) {
    const m = e.model?.[0] as { role?: string; stopReason?: string; toolName?: string; isError?: boolean; details?: { chunk_ids?: unknown } } | undefined;
    if (e.kind === "pi.assistant" && m?.stopReason !== "toolUse") return true;
    if (e.kind === "pi.reset") return true;
    if (e.kind === "pi.tool-result" && m?.toolName && SOURCE_TOOLS.has(m.toolName) && m.isError !== true) {
      const ids = m.details?.chunk_ids;
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === "number") into.add(id);
    }
  }
  return false;
}
