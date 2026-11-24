// 测试替身的再导出：测试代码不直接 import @earendil-works（ADR-01）。
export { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { createHash } from "node:crypto";
import { describeLocal, localToUtc } from "@durakeep/reminders";
import type { Message, ToolResultMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage as msg, fauxProvider as provider, fauxToolCall as toolCall } from "@earendil-works/pi-ai/providers/faux";

/** test / demo 模式下服务进程使用的 faux：固定回复，零费用。 */
export function demoFaux() {
  const faux = provider();
  faux.setResponses(Array.from({ length: 10_000 }, () => (ctx) => (isSummaryRequest(ctx as never) ? msg(DEMO_SUMMARY) : isExtractionRequest(ctx as never) ? msg(DEMO_EXTRACTION) : msg("这是演示模式的回复。"))));
  return faux;
}

const DEMO_EXTRACTION = "[]";

const DEMO_SUMMARY = "- 演示模式的摘要（脚本生成，不是模型输出）";

/** 后台候选记忆提取请求（见 memory 的 ExtractionService）。 */
function isExtractionRequest(ctx: { messages: { role: string; content?: unknown }[] }): boolean {
  const last = ctx.messages[ctx.messages.length - 1];
  const text = Array.isArray(last?.content) ? (last.content as { text?: string }[]).map((p) => p.text ?? "").join("") : String(last?.content ?? "");
  return text.includes("<conversation>\n");
}

/** 后台摘要请求的输入带 document 标签包裹（见 knowledge 的摘要作业）。 */
function isSummaryRequest(ctx: { messages: { role: string; content?: unknown }[] }): boolean {
  const last = ctx.messages[ctx.messages.length - 1];
  const text = Array.isArray(last?.content) ? (last.content as { text?: string }[]).map((p) => p.text ?? "").join("") : String(last?.content ?? "");
  return text.includes("<document>\n");
}

const ENVELOPE = /^\[当前时间 (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) 星期[日一二三四五六] ([^\]\s]+)\]\n/;
const CAPTURE = /^(?:(?:请(?:帮我)?|帮我|麻烦你)\s*)?(?:收藏(?:一下|这段(?:话|文字|内容)?|以下(?:文字|内容)?)?|存下来|保存这段(?:话|文字|内容)?|把(?:这段(?:话|文字|内容)?|以下(?:文字|内容)?)\s*(?:收藏|存下来|保存))\s*[：:,，]?\s*/;
const REMEMBER = /^(?:(?:请(?:帮我)?|帮我)\s*)?记住\s*[：:,，]?\s*/;
const NO_SOURCE = "现有资料不足，无法从已收藏的资料回答。可以先收藏相关资料，再试一次。";
const clip = (s: string, max: number) => [...s].slice(0, max).join("");
const call = (name: string, args: Record<string, string | number>) => msg(toolCall(name, args), { stopReason: "toolUse" });

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

function toolReply(result: ToolResultMessage, messages: Message[]) {
  const text = messageText(result);
  if (result.isError) return msg(`操作未完成：${text}`);
  if (result.toolName === "kb_search") {
    const source = /^<source id="chunk:(\d+)"[^\n]*>\n([\s\S]*?)\n<\/source>/m.exec(text);
    if (!source) return msg(NO_SOURCE);
    const lines = source[2]!.split("\n").map((line) => line.trim()).filter(Boolean);
    const body = lines.find((line) => !line.startsWith("#")) ?? lines[0] ?? "";
    const clean = body.replace(/^#+\s*/, "").replace(/\[\d+\]/g, "").replace(/[<>]/g, "").trim();
    const excerpt = clip(clean, 160);
    const answer = excerpt ? `根据你收藏的资料：${excerpt}${excerpt === clean ? "" : "…"}` : "找到一段相关资料，可在引用中查看原文。";
    return msg(`${answer} [1]\n<citations>\n[1] chunk:${source[1]}\n</citations>`);
  }
  let receipt: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return msg("操作已返回，暂时无法读取回执。");
    receipt = parsed as Record<string, unknown>;
  } catch {
    return msg("操作已返回，暂时无法读取回执。");
  }
  if (result.toolName === "kb_capture_text" && typeof receipt.document_id === "string" && typeof receipt.status === "string") {
    const status = receipt.status;
    const label = status === "ready" ? "可用" : status === "pending" ? "处理中" : status;
    return msg(`${receipt.deduplicated ? "已收藏过这段文字" : "已收藏这段文字"}。资料 ID（document_id）：${receipt.document_id}；状态：${label}（${status}）。`);
  }
  if (result.toolName === "memory_remember" && typeof receipt.memory_id === "string") {
    for (const message of messages.toReversed()) {
      if (message.role !== "assistant") continue;
      const previousCall = message.content.find((p) => p.type === "toolCall" && p.id === result.toolCallId);
      if (previousCall?.type === "toolCall" && typeof previousCall.arguments.value === "string") {
        return msg(`已记住「${previousCall.arguments.value}」。作用范围：全局（global）。`);
      }
    }
  }
  if (result.toolName === "reminder_create" && typeof receipt.local === "string" && typeof receipt.timezone === "string" && typeof receipt.text === "string") {
    return msg(`已创建提醒「${receipt.text}」：${receipt.local}（${receipt.timezone}）。`);
  }
  return msg("操作已返回，暂时无法读取回执。");
}

function reminderReply(text: string, envelope: RegExpExecArray | null) {
  if (!envelope) return msg("没有收到完整的当前时间和时区，暂时无法安排提醒。");
  const [, date, time, timezone] = envelope;
  const relative = /(\d+)\s*分钟\s*(?:以)?后/.exec(text);
  const minutes = relative ? Number(relative[1]) : undefined;
  if (minutes !== undefined && (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 525_600)) {
    return msg("请指定 1 到 525600 分钟后的提醒。");
  }
  try {
    let local: string;
    if (minutes === undefined) {
      const tomorrow = new Date(`${date}T20:00:00Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      local = tomorrow.toISOString().slice(0, 16);
    } else {
      const at = localToUtc(`${date}T${time}`, timezone!) + minutes * 60_000;
      local = describeLocal(at, timezone!).slice(0, 16).replace(" ", "T");
    }
    localToUtc(local, timezone!); // 拒绝夏令时中不存在或重复的本地时间。
    const subject = text.slice(text.indexOf("提醒") + "提醒".length)
      .replace(/^\s*我?\s*[：:,，]?\s*/, "").replace(/\d+\s*分钟\s*(?:以)?后/g, "").trim();
    return call("reminder_create", { text: clip(subject || "查看提醒", 200), local_datetime: local, timezone: timezone! });
  } catch {
    return msg("这个时区或本地时间无法用于提醒，请换一个时间再试。");
  }
}

function demoStep({ messages }: TranscriptContext) {
  // 写入全局偏好后，Pi 可能在工具结果后追加更新的 profile 系统条目。
  const last = messages.findLast((message) => message.role !== "system");
  if (!last) return msg(NO_SOURCE);
  if (last.role === "toolResult") return toolReply(last, messages);
  if (last.role !== "user") return msg(NO_SOURCE);
  const raw = messageText(last);
  const envelope = ENVELOPE.exec(raw);
  const text = raw.slice(envelope?.[0].length ?? 0).trim();
  if (text.startsWith("<document>\n")) return msg(DEMO_SUMMARY);
  if (text.startsWith("<conversation>\n")) return msg(DEMO_EXTRACTION);
  const capture = CAPTURE.exec(text);
  if (capture) {
    const body = text.slice(capture[0].length).trim();
    if (!body) return msg("请把要收藏的文字放在「收藏：」后面。");
    return call("kb_capture_text", { title: clip(body.split("\n", 1)[0]!, 120), text: body });
  }
  const remember = REMEMBER.exec(text);
  if (remember) {
    const value = clip(text.slice(remember[0].length).trim(), 200);
    if (!value) return msg("请在「记住」后面写下你想保存的偏好。");
    const topic = value.includes("总结") ? "summary_style" : createHash("sha256").update(value).digest("hex").slice(0, 16);
    return call("memory_remember", { kind: "preference", key: `demo.preference.${topic}`, value, scope: "global" });
  }
  if (text.includes("提醒")) return reminderReply(text, envelope);
  return call("kb_search", { query: clip(text || "资料", 200), top_k: 4 });
}

export function demoScriptedFaux() {
  const faux = provider();
  faux.setResponses(Array.from({ length: 10_000 }, () => demoStep));
  return faux;
}
