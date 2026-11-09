export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onUnauthenticated: () => void = () => {};
export const setUnauthenticatedHandler = (f: () => void) => {
  onUnauthenticated = f;
};

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    ...(body === undefined ? {} : isForm ? { body } : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (res.ok && !(res.headers.get("content-type") ?? "").includes("json")) return text as T;
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
    if (res.status === 401 && path !== "/v1/auth/login") onUnauthenticated();
    throw new ApiError(res.status, e?.code ?? "http_" + res.status, e?.message ?? `请求失败（${res.status}）`);
  }
  return json as T;
}

export const uuid = () => crypto.randomUUID();

// ---- 线格式类型（06 §3、§4、§7、§9） ----
export type Citation = {
  n: number;
  chunk_id: number | null;
  valid: boolean;
  invalid_reason?: string;
  title?: string;
  loc?: string;
  document_id?: string;
};
export type Entry =
  | { id: string; type: "user"; text: string; at?: number }
  | { id: string; type: "assistant"; text: string; citations?: Citation[] }
  | { id: string; type: "tool"; name: string; ok: boolean; summary?: string }
  | { id: string; type: "event"; kind: string; data: unknown }
  | { id: string; type: "compaction" };
export type Live = {
  running: boolean;
  partialText?: string;
  tools: unknown[];
  queued: number;
  runFailure?: { reason: string; detail?: string; message: string };
};
export type Snapshot = { entries: Entry[]; live: Live; hasEarlier: boolean };
export type Conversation = { id: string; title: string; created_at: number; last_active_at: number; archived: boolean };
export type Doc = {
  id: string;
  source_type: string;
  source_uri: string | null;
  title: string;
  status: string;
  tags: string[];
  created_at: number;
  updated_at: number;
  error_code: string | null;
};
export type Version = { id: string; captured_at: number; status: string; char_count: number; summary: string | null; current: boolean };
export type Job = {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  max_attempts: number;
  error_code: string | null;
  error_message: string | null;
  document_id: string | null;
  updated_at: number;
};

export type Memory = {
  id: string;
  kind: string;
  key: string;
  value: string;
  scope: string;
  status: string;
  revision: number;
  source: { kind: string };
  updated_at: number;
};
export type MemoryRevision = { revision: number; value: string; status: string; changed_by: string; changed_at: number };
export type Reminder = {
  id: string;
  text: string;
  local: string;
  timezone: string;
  local_datetime: string;
  next_fire_at: number | null;
  revision: number;
  status: string;
  last_occurrence: { fired_at: number; late_ms: number } | null;
};
export type Notification = { id: string; kind: string; title: string; body: string; link: string | null; created_at: number; read: boolean };
