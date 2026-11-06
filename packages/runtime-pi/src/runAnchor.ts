import { LiveDoc } from "@earendil-works/pi-durable";

type AnchorApi = {
  conversationId: unknown;
  snapshot: (token: typeof LiveDoc, conversationId: never, ctx: never) => Promise<{ run?: { first?: unknown } } | undefined>;
};

/**
 * run 锚点（ADR-04、05 §5.2）：当前 run 的第一个条目 ID。同一个 run 内多轮工具调用保持不变，新 run 变化，进程重启后稳定。
 * 类型上 `run.first` 是可选的：读不到返回 undefined，调用方必须报错而不是继续（否则会按 undefined 算 op_key）。
 */
export async function runAnchor(api: unknown, ctx: unknown): Promise<string | undefined> {
  const a = api as AnchorApi;
  const live = await a.snapshot(LiveDoc, a.conversationId as never, ctx as never);
  return live?.run?.first === undefined ? undefined : String(live.run.first);
}
