// Pi 条目 → 应用视图 AppEntry（05 §7 的转换规则）。纯函数，不触碰存储。
import type { AppEntry, ConversationSnapshot, Json, RunFailureReason } from "@durakeep/core";

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
    case "pi.assistant":
      return { id, kind: "assistant", text: textOf(msg?.content) };
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
  const partial = textOf(live.generation?.message?.content);
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
