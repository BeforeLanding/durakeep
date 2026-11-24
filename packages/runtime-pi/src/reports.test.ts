import type { Report } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { presentPiReport } from "./reports.ts";

test("报告跨过运行时边界时剥离原始错误、扩展数据与自由文本", () => {
  const report = {
    kind: "task_interrupted",
    task: { id: 17, conversationId: 29, kind: "private task name" },
    extension: "private extension",
    reason: "restart_limit",
    restarts: 5,
    error: new Error("private content"),
  } satisfies Omit<Extract<Report, { kind: "task_interrupted" }>, "task"> & { task: { id: number; conversationId: number; kind: string } };
  expect(presentPiReport(report as Report)).toEqual({
    report_kind: "task_interrupted", task_id: "17", conversation_id: "29", reason: "restart_limit",
  });
});
