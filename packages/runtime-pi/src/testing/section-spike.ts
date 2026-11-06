// T-03 实验：异步 section 读取宿主数据库。生产的 profile section 在 P2 另行实现。
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";

export function profileSpikeExtension(db: NodeSqliteDatabase, renderCount: { n: number }) {
  return defineExtension({
    name: "t03-profile",
    sections: [
      section("preamble", () => "你是测试助手。", { tag: false }),
      section("profile", async () => {
        renderCount.n++;
        // 异步读取宿主数据（与 Pi 共用同一个连接队列）
        const rows = await db.all<{ note: string }>("SELECT note FROM app_probe WHERE owner_id = ? ORDER BY note", "o1");
        if (rows.length === 0) return undefined;
        return rows.map((r) => `- ${r.note}`).join("\n");
      }),
    ],
  });
}
