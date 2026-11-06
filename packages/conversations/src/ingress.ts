import { createHash } from "node:crypto";
import { AppError, canonicalJson, fault, RuntimeBusy, uuidv7, type Clock, type RuntimePort } from "@durakeep/core";
import type { SqlDatabase } from "@durakeep/db";
import type { ConversationService } from "./conversations.ts";

export const MAX_TEXT_CHARS = 8000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AcceptInput = { clientRequestId: unknown; text: unknown; steer?: unknown };
export type AcceptResult = {
  ingressId: string;
  submissionId: string | null;
  status: "accepted" | "dispatched";
  deduplicated: boolean;
};

type IngressRow = {
  id: string;
  owner_id: string;
  conversation_id: string;
  payload_hash: string;
  payload_json: string | null;
  pi_request_id: string;
  submission_id: string | null;
  status: "accepted" | "dispatched" | "rejected";
  created_at: number;
};

export type LogFn = (e: { level: "info" | "warn" | "error"; event: string; [k: string]: string | number | boolean | undefined }) => void;

type Payload = { text: string; steer: boolean; tz: string };

const COLS = "id, owner_id, conversation_id, payload_hash, payload_json, pi_request_id, submission_id, status, created_at";

/**
 * 入口（ADR-07、03 §5.1）：先在业务事务里写入 app_ingress_events 并比对哈希，再交给 Pi 的 requestId。
 * “accepted”表示已持久化、不会丢失；是否已交给 Pi 由 dispatched 区分。
 */
export class IngressService {
  readonly #db: SqlDatabase;
  readonly #runtime: RuntimePort;
  readonly #clock: Clock;
  readonly #conversations: ConversationService;
  readonly #log: LogFn;

  constructor(
    db: SqlDatabase,
    runtime: RuntimePort,
    clock: Clock,
    conversations: ConversationService,
    log: LogFn = () => {},
  ) {
    this.#db = db;
    this.#runtime = runtime;
    this.#clock = clock;
    this.#conversations = conversations;
    this.#log = log;
  }

  async accept(owner: { id: string; timezone: string }, conversationId: string, input: AcceptInput): Promise<AcceptResult> {
    const crid = input.clientRequestId;
    if (typeof crid !== "string" || !UUID.test(crid)) {
      throw new AppError("invalid_request", "client_request_id 必须是 UUID", { issues: [{ path: "client_request_id" }] });
    }
    const text = input.text;
    if (typeof text !== "string" || text.trim() === "" || Array.from(text).length > MAX_TEXT_CHARS) {
      throw new AppError("invalid_request", `text 长度需为 1–${MAX_TEXT_CHARS} 个字符`, { issues: [{ path: "text" }] });
    }
    if (input.steer !== undefined && typeof input.steer !== "boolean") {
      throw new AppError("invalid_request", "steer 必须是布尔值", { issues: [{ path: "steer" }] });
    }
    const steer = input.steer === true;
    const conv = await this.#conversations.getActive(owner.id, conversationId);

    // payload_hash 同时覆盖会话 ID：同一个 client_request_id 发往不同会话也算冲突（R10）
    const hash = createHash("sha256").update(canonicalJson({ conversation: conv.id, text, steer })).digest("hex");
    const now = this.#clock.now();
    const payload: Payload = { text, steer, tz: owner.timezone };

    const { row, created } = await this.#db.transaction(async (tx) => {
      const existing = await tx.get<IngressRow>(
        `SELECT ${COLS} FROM app_ingress_events WHERE owner_id = ? AND channel = 'web' AND client_request_id = ?`,
        owner.id,
        crid,
      );
      if (existing) {
        if (existing.payload_hash !== hash) {
          throw new AppError("idempotency_conflict", "同一个请求 ID 对应了不同的内容");
        }
        return { row: existing, created: false };
      }
      const id = uuidv7(now);
      await tx.run(
        `INSERT INTO app_ingress_events
           (id, owner_id, channel, client_request_id, conversation_id, payload_hash, payload_json, pi_request_id, status, created_at)
         VALUES (?, ?, 'web', ?, ?, ?, ?, ?, 'accepted', ?)`,
        id,
        owner.id,
        crid,
        conv.id,
        hash,
        JSON.stringify(payload),
        `web:${crid}`,
        now,
      );
      const inserted = await tx.get<IngressRow>(`SELECT ${COLS} FROM app_ingress_events WHERE id = ?`, id);
      return { row: inserted!, created: true };
    });
    fault("ingress.after_insert"); // 已持久化、尚未交给 Pi

    if (row.status === "dispatched") {
      return { ingressId: row.id, submissionId: row.submission_id, status: "dispatched", deduplicated: !created };
    }
    // accepted：（重新）派发。Pi 按 requestId 去重，重复派发不会产生第二个 submission。
    const submissionId = await this.#dispatch(row, conv.piConversationId, payload);
    if (created) await this.#conversations.touch(owner.id, conv.id);
    return {
      ingressId: row.id,
      submissionId,
      status: submissionId === null ? "accepted" : "dispatched",
      deduplicated: !created,
    };
  }

  /** 交给 Pi 并记下 submission；运行时暂不可用时保持 accepted（不丢失，由恢复扫描再派发）。 */
  async #dispatch(row: IngressRow, piConversationId: string, payload?: Payload): Promise<string | null> {
    const p = payload ?? (row.payload_json ? (JSON.parse(row.payload_json) as Payload) : undefined);
    if (!p) return row.submission_id; // 没有原文可发（不应出现）
    let submissionId: string;
    try {
      ({ submissionId } = await this.#runtime.submitInput(piConversationId, {
        text: p.text,
        requestId: row.pi_request_id,
        steer: p.steer,
        now: row.created_at,
        tz: p.tz,
      }));
    } catch (e) {
      this.#log({ level: "warn", event: "ingress.dispatch_failed", ingress_id: row.id, error: (e as Error).name });
      return null;
    }
    // 原文只为恢复而存：派发成功后清掉，避免正文在业务库里重复保存
    await this.#db.run(
      "UPDATE app_ingress_events SET status = 'dispatched', submission_id = ?, dispatched_at = ?, payload_json = NULL WHERE id = ? AND status = 'accepted'",
      submissionId,
      this.#clock.now(),
      row.id,
    );
    return submissionId;
  }

  /** 启动恢复扫描（03 §5.5）：把仍为 accepted 的记录用原 requestId 重新派发。返回处理条数。 */
  async recover(): Promise<{ redispatched: number; failed: number }> {
    const rows = await this.#db.all<IngressRow & { pi_conversation_id: string }>(
      `SELECT e.id, e.owner_id, e.conversation_id, e.payload_hash, e.payload_json, e.pi_request_id, e.submission_id, e.status, e.created_at,
              c.pi_conversation_id
         FROM app_ingress_events e JOIN app_conversations c ON c.id = e.conversation_id
        WHERE e.status = 'accepted' ORDER BY e.created_at, e.id`,
    );
    let redispatched = 0;
    let failed = 0;
    for (const r of rows) {
      const id = await this.#dispatch(r, r.pi_conversation_id);
      if (id === null) failed++;
      else redispatched++;
    }
    if (rows.length > 0) this.#log({ level: "info", event: "ingress.recovered", redispatched, failed });
    return { redispatched, failed };
  }

  /** 继续一个失败的 run（FR-CHAT-05）。会话忙 → 409。 */
  async continue(ownerId: string, conversationId: string): Promise<{ submissionId: string }> {
    const conv = await this.#conversations.getActive(ownerId, conversationId);
    try {
      return await this.#runtime.submitContinue(conv.piConversationId);
    } catch (e) {
      if (e instanceof RuntimeBusy) throw new AppError("conversation_busy", "会话正忙，请稍后再试");
      throw e;
    }
  }

  /** 停止当前 run 并撤回排队中的输入（FR-CHAT-04）。 */
  async abort(ownerId: string, conversationId: string): Promise<{ status: "idle" }> {
    const conv = await this.#conversations.get(ownerId, conversationId);
    await this.#runtime.abort(conv.piConversationId);
    return { status: "idle" };
  }
}
