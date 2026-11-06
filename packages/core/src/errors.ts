// 业务错误：code 为 snake_case，面向用户的消息为中文；列表见 docs/06-api.md §1。
export type ErrorCode =
  | "invalid_request"
  | "unauthenticated"
  | "origin_mismatch"
  | "not_found"
  | "idempotency_conflict"
  | "conversation_busy"
  | "revision_conflict"
  | "too_large"
  | "ssrf_blocked"
  | "unsupported_type"
  | "time_in_past"
  | "locked"
  | "rate_limited"
  | "runtime_unavailable"
  | "delivery_paused"
  | "internal";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string;
  readonly details: Record<string, unknown>;
  constructor(code: ErrorCode, userMessage: string, details: Record<string, unknown> = {}) {
    super(`${code}: ${userMessage}`);
    this.name = "AppError";
    this.code = code;
    this.userMessage = userMessage;
    this.details = details;
  }
}
