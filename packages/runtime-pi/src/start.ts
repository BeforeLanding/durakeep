import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase, type NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import type { FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type Extension, type HarnessSettings, type Report } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import type { AppMode } from "@durakeep/core";
import { createRealProvider } from "./provider.ts";

export type PiDeps = {
  mode: AppMode;
  /** SQLite 文件路径；Pi 表使用 pi_ 前缀（ADR-02）。 */
  dbPath: string;
  /** test / demo 必须提供。 */
  faux?: FauxProviderHandle;
  extensions?: Extension[];
  /** 需要用到共享连接的扩展（如读取宿主数据的 section）用它来构造。 */
  extensionsFactory?: (db: NodeSqliteDatabase) => Extension[];
  now?: () => number;
  settings?: HarnessSettings;
  /** 05 §9：Pi 的报告（任务故障、存储失败等）。 */
  onReport?: (report: Report) => void;
  /** Harness 因存储错误失效（harness.closed 为 failed）：宿主应记录并退出进程，重启后恢复。 */
  onFatal?: (error: unknown) => void;
};

export const context = BACKGROUND_CONTEXT;

export type PiHandle = {
  db: NodeSqliteDatabase;
  harness: Harness;
  close(): Promise<void>;
};

export async function startPi(deps: PiDeps): Promise<PiHandle> {
  const models = createModels();
  if (deps.mode === "test" || deps.mode === "demo") {
    if (deps.faux === undefined) throw new Error(`APP_MODE=${deps.mode} 需要 faux provider`);
    models.setProvider(deps.faux.provider);
  } else {
    models.setProvider(await createRealProvider(deps.mode));
  }

  const db = await openNodeSqliteDatabase(deps.dbPath);
  const registry = createRegistry();
  for (const ext of deps.extensions ?? []) registry.install(ext);
  for (const ext of deps.extensionsFactory?.(db) ?? []) registry.install(ext);
  const storage = await SqliteStorage.open(db, { prefix: "pi_" });
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      identity: { attribution: null },
      ...(deps.settings ? { settings: deps.settings } : {}),
      ...(deps.onReport ? { onReport: deps.onReport } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    },
    context,
  );
  void harness.closed.then((end) => {
    if (end.kind === "failed") deps.onFatal?.(end.error);
  });
  return {
    db,
    harness,
    async close() {
      await harness.close(context);
    },
  };
}
