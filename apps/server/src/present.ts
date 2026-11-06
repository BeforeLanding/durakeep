// 内部 AppEntry / ConversationSnapshot → HTTP 线格式（06 §3、§9）。
import type { AppEntry, ConversationSnapshot, RunFailureReason } from "@durakeep/core";

const REASON_TEXT: Record<RunFailureReason, (detail?: string) => string> = {
  model_error: (d) => `模型服务出错${d ? `：${d}` : ""}`,
  turn_limit: () => "工具调用轮数到达上限（8 轮）",
  restart_limit: () => "服务多次中断，已停止这次回答",
  interrupted: () => "服务多次中断，已停止这次回答",
  aborted: () => "已停止",
  nothing_to_answer: () => "没有需要继续的内容",
  no_model: () => "没有配置模型",
  reset: () => "对话已重置",
  faulted: () => "这次回答出现内部错误",
  orphaned: () => "这次回答所需的组件已不可用",
};

export function presentEntry(e: AppEntry) {
  switch (e.kind) {
    case "user":
      return { id: e.id, type: "user", text: e.text, ...(e.at !== undefined ? { at: e.at } : {}) };
    case "assistant":
      return { id: e.id, type: "assistant", text: e.text };
    case "tool":
      return { id: e.id, type: "tool", name: e.name, ok: e.ok, ...(e.summary ? { summary: e.summary } : {}) };
    case "event":
      return { id: e.id, type: "event", kind: e.eventKind.replace(/^app\./, ""), data: e.data };
    case "compaction":
      return { id: e.id, type: "compaction" };
  }
}

export function presentSnapshot(s: ConversationSnapshot) {
  const f = s.live.runFailure;
  return {
    entries: s.entries.map(presentEntry),
    live: {
      running: s.live.running,
      ...(s.live.partialText !== undefined ? { partialText: s.live.partialText } : {}),
      tools: s.live.tools,
      queued: s.live.queued,
      ...(f ? { runFailure: { reason: f.reason, ...(f.detail ? { detail: f.detail } : {}), message: REASON_TEXT[f.reason](f.detail) } } : {}),
    },
    hasEarlier: s.hasEarlier,
  };
}
