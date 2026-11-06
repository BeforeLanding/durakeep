// T-04 实验写工具 + run 锚点。生产写工具（P1/P2）按同样的结构实现。
import { normalizeText, opKey } from "@durakeep/core";
import { guardDb, once, type SqlDatabase } from "@durakeep/db";
import type { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { defineExtension, defineTool, LiveDoc } from "@earendil-works/pi-durable";
import { fault } from "@durakeep/core";
import { obj, str } from "@earendil-works/pi-schema";

type AnchorApi = {
  conversationId: string;
  snapshot: (token: typeof LiveDoc, conversationId: string, ctx: never) => Promise<{ run?: { first?: string } } | undefined>;
};

/** run 锚点：当前 run 的第一个条目 ID；读不到返回 undefined（05 §5.2 的备选方案届时启用）。 */
export async function runAnchor(api: unknown, ctx: unknown): Promise<string | undefined> {
  const a = api as AnchorApi;
  const live = await a.snapshot(LiveDoc, a.conversationId, ctx as never);
  return live?.run?.first === undefined ? undefined : String(live.run.first);
}

export type WriteSpikeLog = (e: { opKey: string; anchor: string | undefined; deduplicated: boolean; text: string }) => void;

export function writeSpikeExtension(rawDb: NodeSqliteDatabase, log: WriteSpikeLog) {
  const db: SqlDatabase = guardDb(rawDb);
  const probeWrite = defineTool({
    name: "probe_write",
    description: "写入一条探测记录（幂等）",
    parameters: obj({ text: str() }),
    replay: "safe",
    callers: ["model"],
    execute: async (args, api, ctx) => {
      const text = normalizeText(args.text);
      const anchor = await runAnchor(api, ctx);
      if (anchor === undefined) throw new Error("读不到 run 锚点");
      const key = opKey(String(api.conversationId), anchor, "probe_write", { text });
      const { result, deduplicated } = await once(db, "o1", key, "probe_write", { text }, async (tx) => {
        await tx.run("INSERT INTO app_probe (owner_id, n, note) VALUES (?, ?, ?)", "o1", 0, text);
        return { ok: true };
      });
      log({ opKey: key, anchor, deduplicated, text });
      fault("tool.after_business_commit"); // 业务已提交、结果尚未交给 Pi
      return { output: [{ type: "text", text: JSON.stringify({ ...result, deduplicated }) }] };
    },
  });
  return defineExtension({ name: "t04-write", tools: [probeWrite] });
}
