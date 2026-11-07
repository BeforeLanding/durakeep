import { expect, test } from "vitest";
import { collectRunChunkIds, toAppEntry, type PiEntryLike } from "./convert.ts";

let id = 0;
const assistantTool = (): PiEntryLike => ({ id: ++id, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall" }] }] });
const assistantFinal = (text = "答"): PiEntryLike => ({ id: ++id, kind: "pi.assistant", model: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] }] });
const result = (toolName: string, chunkIds: number[], isError = false): PiEntryLike => ({ id: ++id, kind: "pi.tool-result", model: [{ role: "toolResult", toolName, isError, details: { chunk_ids: chunkIds } }] });
const user = (): PiEntryLike => ({ id: ++id, kind: "app.user", data: { text: "问" }, model: [{ role: "user", content: "问" }] });
const desc = (...entries: PiEntryLike[]) => [...entries].reverse(); // 传入的是“从助手条目的前一条开始、ID 递减”

test("收集同一次 run 里 kb_search 与 kb_get_source 的 chunk id，遇到上一个回答就停止（run 边界）", () => {
  const entries = [
    user(), assistantTool(), result("kb_search", [1, 2]), assistantFinal(), // 上一个 run：chunk 1、2 不属于下一个 run
    user(), assistantTool(), result("kb_search", [10, 11]), assistantTool(), result("kb_get_source", [11, 12]), // 当前 run
  ];
  const ids = new Set<number>();
  const hitBoundary = collectRunChunkIds(desc(...entries), ids);
  expect(hitBoundary).toBe(true);
  expect([...ids].sort((a, b) => a - b)).toEqual([10, 11, 12]);
});

test("插话（steer）发生在 run 内部，不会截断：它之前的工具结果仍然算数", () => {
  const entries = [user(), assistantTool(), result("kb_search", [5]), user() /* steer */, assistantTool(), result("kb_search", [6])];
  const ids = new Set<number>();
  expect(collectRunChunkIds(desc(...entries), ids)).toBe(false); // 一直回溯到了开头，没有碰到上一个回答
  expect([...ids].sort()).toEqual([5, 6]);
});

test("只认 kb_search / kb_get_source；出错的结果、别的工具、没有 details 的结果都不算", () => {
  const ids = new Set<number>();
  collectRunChunkIds(
    desc(
      result("kb_list_documents", [100]),
      result("kb_capture_text", [101]),
      result("kb_search", [102], true),
      { id: ++id, kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "kb_search", isError: false, details: {} }] },
      { id: ++id, kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "kb_search", isError: false, details: { chunk_ids: ["7", null, 8] } }] },
    ),
    ids,
  );
  expect([...ids]).toEqual([8]); // chunk_ids 里只有数字才算
});

test("reset 也是 run 的边界；跨页调用时累积同一个集合", () => {
  const ids = new Set<number>();
  const page2 = [result("kb_search", [1]), { id: ++id, kind: "pi.reset" } as PiEntryLike, result("kb_search", [2])];
  expect(collectRunChunkIds(desc(...page2), ids)).toBe(true);
  expect([...ids]).toEqual([2]);
  const into = new Set<number>([9]);
  expect(collectRunChunkIds(desc(result("kb_get_source", [3])), into)).toBe(false);
  expect([...into].sort()).toEqual([3, 9]);
});

test("助手条目转换：去掉 <citations> 块、保留引用与标记；没有引用的回答不带这两个字段", () => {
  const e = toAppEntry({ id: 5, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "建议如此 [1]。\n<citations>\n[1] chunk:42\n</citations>" }] }] });
  expect(e).toEqual({ id: "5", kind: "assistant", text: "建议如此 [1]。", citations: [{ n: 1, chunkId: 42, inRun: false }], markers: [1] });
  const plain = toAppEntry({ id: 6, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "现有资料不足。" }] }] });
  expect(plain).toEqual({ id: "6", kind: "assistant", text: "现有资料不足。" });
});
