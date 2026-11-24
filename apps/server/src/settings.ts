import { AppError } from "@durakeep/core";
import type { SqlDatabase, SqlExecutor } from "@durakeep/db";
import { assertTimezone } from "@durakeep/reminders";

export type ChatModel = "deepseek-flash" | "deepseek-v4-pro";
type Settings = { chat_model: ChatModel; monthly_budget_usd: number; timezone: string; backup_keep: number };
const FIELDS = ["chat_model", "monthly_budget_usd", "timezone", "backup_keep"];

export function isChatModel(value: unknown): value is ChatModel {
  return value === "deepseek-flash" || value === "deepseek-v4-pro";
}

export async function readSetting(db: SqlExecutor, key: string): Promise<unknown> {
  const row = await db.get<{ value_json: string }>("SELECT value_json FROM app_settings WHERE key = ?", key);
  if (row) {
    try {
      return JSON.parse(row.value_json) as unknown;
    } catch {
      return undefined;
    }
  }
}

export async function writeSetting(db: SqlExecutor, key: string, value: unknown, now: number): Promise<void> {
  await db.run(
    "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
    key, JSON.stringify(value), now,
  );
}

const validBudget = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const validKeep = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const budgetKey = (ownerId: string) => `monthly_budget_usd:${ownerId}`;

export async function readBudget(db: SqlExecutor, ownerId: string): Promise<number> {
  const v = await readSetting(db, budgetKey(ownerId));
  return validBudget(v) ? v : 5;
}

export async function readBackupKeep(db: SqlExecutor): Promise<number> {
  const v = await readSetting(db, "backup_keep");
  return validKeep(v) ? v : 7;
}

export async function readChatModel(db: SqlExecutor, fallback: ChatModel = "deepseek-flash"): Promise<ChatModel> {
  const v = await readSetting(db, "chat_model");
  return isChatModel(v) ? v : fallback;
}

export async function readSettings(db: SqlExecutor, ownerId: string, fallback?: ChatModel): Promise<Settings> {
  const owner = await db.get<{ timezone: string }>("SELECT timezone FROM app_owners WHERE id = ?", ownerId);
  if (!owner) throw new AppError("not_found", "账号不存在");
  return {
    chat_model: await readChatModel(db, fallback),
    monthly_budget_usd: await readBudget(db, ownerId),
    timezone: owner.timezone,
    backup_keep: await readBackupKeep(db),
  };
}

export async function updateSettings(db: SqlDatabase, ownerId: string, value: unknown, now: number, fallback?: ChatModel): Promise<Settings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("invalid_request", "请求体需为 JSON 对象");
  const { chat_model, monthly_budget_usd, timezone, backup_keep } = value as Record<string, unknown>;
  const invalid = (path: string, message: string) => new AppError("invalid_request", message, { issues: [{ path }] });
  const unknown = Object.keys(value).find((key) => !FIELDS.includes(key));
  if (unknown !== undefined) throw invalid(unknown, "不支持的设置项");
  if (chat_model !== undefined && !isChatModel(chat_model)) throw invalid("chat_model", "模型需为 deepseek-flash 或 deepseek-v4-pro");
  if (monthly_budget_usd !== undefined && !validBudget(monthly_budget_usd)) throw invalid("monthly_budget_usd", "月度预算需为有限正数");
  if (backup_keep !== undefined && !validKeep(backup_keep)) throw invalid("backup_keep", "保留份数需为正的安全整数");
  if (timezone !== undefined) assertTimezone(timezone);

  return db.transaction(async (tx) => {
    if (chat_model !== undefined) await writeSetting(tx, "chat_model", chat_model, now);
    if (monthly_budget_usd !== undefined) await writeSetting(tx, budgetKey(ownerId), monthly_budget_usd, now);
    if (backup_keep !== undefined) await writeSetting(tx, "backup_keep", backup_keep, now);
    if (typeof timezone === "string") await tx.run("UPDATE app_owners SET timezone = ? WHERE id = ?", timezone, ownerId);
    return readSettings(tx, ownerId, fallback);
  });
}
