import { fault, type Clock, type RuntimePort } from "@durakeep/core";
import type { SqlDatabase } from "@durakeep/db";
import type { JobContext } from "./worker.ts";
import { JobError } from "./worker.ts";

/**
 * 后台模型调用（ADR-10、05 §8）：每个作业有一个专用的后台会话，会话 ID 记在 app_jobs.pi_conversation_id；
 * 每个阶段用 requestId = job:<job_id>:<stage> 提交。崩溃后重跑同一阶段会拿回已有的 submission，不会再付费调用一次。
 * 答案同时记进 checkpoint，之后的重试连 submission 都不必再查。
 */
export class BackgroundModel {
  readonly #db: SqlDatabase;
  readonly #runtime: () => RuntimePort;
  readonly #clock: Clock;

  /** runtime 用函数传入：作业队列先于运行时创建（运行时的扩展又依赖业务服务）。 */
  constructor(db: SqlDatabase, clock: Clock, runtime: () => RuntimePort) {
    this.#db = db;
    this.#clock = clock;
    this.#runtime = runtime;
  }

  async ask(ctx: JobContext, stage: string, input: { instructions: string; prompt: string }): Promise<string> {
    const key = `answer:${stage}`;
    const saved = ctx.checkpoint[key];
    if (typeof saved === "string") return saved;

    const rt = this.#runtime();
    const jobId = ctx.job.id;
    const conv = await this.#conversation(rt, ctx, input.instructions);
    const owner = await this.#db.get<{ timezone: string }>("SELECT timezone FROM app_owners WHERE id = ?", ctx.job.ownerId);
    const { submissionId } = await rt.submitInput(conv, {
      text: input.prompt,
      requestId: `job:${jobId}:${stage}`,
      steer: false,
      now: this.#clock.now(),
      tz: owner?.timezone ?? "Asia/Shanghai",
    });
    const settled = await rt.waitSubmission(submissionId);
    if (settled.status !== "done") {
      // model_error 多半是限流 / 超时：值得退避重试；其他原因（没有模型、被中止）重试没有意义
      throw new JobError("model_failed", `模型没有给出回答（${settled.reason}）`, settled.reason === "model_error" || settled.reason === "interrupted");
    }
    fault("background.after_answer"); // 模型已回答、业务尚未写回（R14）
    await ctx.save({ [key]: settled.answerText });
    return settled.answerText;
  }

  /** 复用：已记录就直接用；否则创建并写回。写回用条件更新——并发或崩溃遗留时以先写入者为准，多出来的会话是无害的孤儿（ADR-10）。 */
  async #conversation(rt: RuntimePort, ctx: JobContext, instructions: string): Promise<string> {
    const { ownerId, id } = ctx.job;
    const row = await this.#db.get<{ pi_conversation_id: string | null }>("SELECT pi_conversation_id FROM app_jobs WHERE owner_id = ? AND id = ?", ownerId, id);
    if (row?.pi_conversation_id) return row.pi_conversation_id;
    const { piConversationId } = await rt.createConversation({ kind: "background", instructions, job: { ownerId, id } });
    fault("background.after_create"); // 会话已创建、ID 尚未写入作业：留下一个孤儿会话
    await this.#db.run("UPDATE app_jobs SET pi_conversation_id = ? WHERE owner_id = ? AND id = ? AND pi_conversation_id IS NULL", piConversationId, ownerId, id);
    const again = await this.#db.get<{ pi_conversation_id: string }>("SELECT pi_conversation_id FROM app_jobs WHERE owner_id = ? AND id = ?", ownerId, id);
    return again!.pi_conversation_id;
  }
}
