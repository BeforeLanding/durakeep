import type { SqlExecutor } from "./sql.ts";

export async function deliveryPaused(db: SqlExecutor): Promise<boolean> {
  const row = await db.get<{ value_json: string }>("SELECT value_json FROM app_settings WHERE key = 'delivery_paused'");
  return row?.value_json === "true";
}

export async function setDeliveryPaused(db: SqlExecutor, paused: boolean, now: number): Promise<void> {
  await db.run(
    "INSERT INTO app_settings (key, value_json, updated_at) VALUES ('delivery_paused', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
    JSON.stringify(paused), now,
  );
}
