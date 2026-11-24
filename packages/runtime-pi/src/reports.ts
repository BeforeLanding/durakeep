import type { Report } from "@earendil-works/pi-durable";

/** 宿主只接收已筛选的 ID 和枚举，不能访问报告中的 error、堆栈和正文。 */
export function presentPiReport(report: Report) {
  const task = "task" in report ? report.task : undefined;
  const conversationId = task?.conversationId ?? ("conversationId" in report ? report.conversationId : undefined);
  return {
    report_kind: report.kind,
    ...(task ? { task_id: String(task.id) } : {}),
    ...(conversationId === undefined ? {} : { conversation_id: String(conversationId) }),
    ...("reason" in report ? { reason: report.reason } : report.kind === "migration_failed" ? { reason: "migration_failed" as const } : {}),
  };
}

export type PiDiagnostic = ReturnType<typeof presentPiReport>;
