import { createHash } from "node:crypto";
import { canonicalJson, type Json } from "./canonicalJson.ts";

/**
 * ADR-04：op_key = sha256(conversation_id, run_anchor, tool_name, canonical_json(normalized_args))。
 * 用 JSON 数组做定界，避免字段拼接产生歧义。
 */
export function opKey(conversationId: string, runAnchor: string, toolName: string, normalizedArgs: Json): string {
  const material = canonicalJson([conversationId, runAnchor, toolName, normalizedArgs]);
  return createHash("sha256").update(material).digest("hex");
}

/** 规范化文本：去掉首尾空白（其他规则随各工具的 normalize 函数定义）。 */
export function normalizeText(s: string): string {
  return s.trim();
}
