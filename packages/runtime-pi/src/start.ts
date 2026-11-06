import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase, type NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import type { FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, type Extension } from "@earendil-works/pi-durable";
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
  now?: () => number;
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

  const registry = createRegistry();
  for (const ext of deps.extensions ?? []) registry.install(ext);

  const db = await openNodeSqliteDatabase(deps.dbPath);
  const storage = await SqliteStorage.open(db, { prefix: "pi_" });
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      identity: { attribution: null },
      ...(deps.now ? { now: deps.now } : {}),
    },
    context,
  );
  return {
    db,
    harness,
    async close() {
      await harness.close(context);
    },
  };
}
