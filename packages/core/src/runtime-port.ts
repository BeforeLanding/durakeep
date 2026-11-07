// RuntimePort（ADR-01、05 §7）：业务与 HTTP 层看到的唯一运行时接口。实现在 packages/runtime-pi。
import type { RawCitation } from "./citations.ts";
import type { Json } from "./canonicalJson.ts";

/** 与 Pi 的 RunFailureReason 对应；core 里重述一份，业务代码不 import Pi 的类型。 */
export type RunFailureReason =
  | "model_error"
  | "no_model"
  | "aborted"
  | "reset"
  | "faulted"
  | "orphaned"
  | "interrupted"
  | "restart_limit"
  | "nothing_to_answer"
  | "turn_limit";

/** 不透明的恢复游标：交给 observe 的 from，让重连只补发错过的条目。 */
export type ResumeCursor = string;

export type AppEntry =
  | { id: string; kind: "user"; text: string; at?: number; tz?: string }
  | {
      id: string;
      kind: "assistant";
      /** 已去掉 <citations> 块的可见正文。 */
      text: string;
      /** 回答里声明的引用（未校验）；inRun 由运行时填写。校验在 CitationValidator 里、在展示时进行。 */
      citations?: RawCitation[];
      /** 正文里出现的 [n] 标记。 */
      markers?: number[];
    }
  | { id: string; kind: "tool"; name: string; ok: boolean; summary?: string }
  | { id: string; kind: "event"; eventKind: string; data: Json }
  | { id: string; kind: "compaction" };

export type ConversationSnapshot = {
  /** 此刻的恢复游标（SSE 的 id）；传回 observe 的 from 即可只补发之后的条目。空会话为 undefined。 */
  cursor?: ResumeCursor;
  entries: AppEntry[];
  live: {
    running: boolean;
    partialText?: string;
    tools: { callId: string; name: string; status: "running" | "done" | "error"; summary?: string }[];
    runFailure?: { reason: RunFailureReason; detail?: string };
    queued: number;
  };
  hasEarlier: boolean;
};

export type UsageSummary = { models: Record<string, Json>; tools: Record<string, Json> };

/** 会话正忙时 submitContinue 抛出。 */
export class RuntimeBusy extends Error {
  readonly code = "runtime_busy";
  constructor() {
    super("会话正忙");
    this.name = "RuntimeBusy";
  }
}

export interface RuntimePort {
  /** 启动调度：继续上一个进程未完成的 run 和工具（03 §3 第 8 步，在恢复扫描之后调用）。 */
  resume(): void;
  createConversation(input: {
    kind: "chat" | "background";
    instructions?: string;
  }): Promise<{ piConversationId: string }>;
  submitInput(
    conv: string,
    input: { text: string; requestId: string; steer: boolean; now: number; tz: string },
  ): Promise<{ submissionId: string }>;
  submitContinue(conv: string): Promise<{ submissionId: string }>;
  writeEvent(conv: string, entry: { kind: `app.${string}`; data: Json }, requestId: string): Promise<void>;
  waitSubmission(
    id: string,
    signal?: AbortSignal,
  ): Promise<
    | { status: "done"; answerText: string }
    | { status: "unanswered"; reason: RunFailureReason | string; detail?: string }
  >;
  abort(conv: string): Promise<void>;
  observe(
    conv: string,
    from: ResumeCursor | undefined,
    listener: (snap: ConversationSnapshot) => void,
  ): Promise<{ stop(): Promise<void>; cursor(): ResumeCursor | undefined }>;
  /** 加载比 beforeEntryId（不含）更早的条目，升序返回至多 limit 条可展示的条目；before 缺省 = 从最新开始。 */
  loadEarlier(
    conv: string,
    beforeEntryId: string | undefined,
    limit: number,
  ): Promise<{ entries: AppEntry[]; hasEarlier: boolean }>;
  usage(): Promise<UsageSummary>;
  backupInto(path: string): Promise<void>;
  close(): Promise<void>;
}
