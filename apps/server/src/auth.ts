import { createHash, randomBytes } from "node:crypto";
import { AppError, uuidv7, type Clock } from "@durakeep/core";
import type { SqlDatabase } from "@durakeep/db";
import { hashPassword, verifyPassword } from "./password.ts";

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // FR-AUTH-01
export const MAX_FAILURES = 5; // S2
export const LOCK_MS = 60_000; // S2

export type Owner = { id: string; displayName: string; timezone: string };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function assertTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new AppError("invalid_request", `无效的时区：${tz}`);
  }
}

export class AuthService {
  readonly #db: SqlDatabase;
  readonly #clock: Clock;
  constructor(db: SqlDatabase, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  /** `pnpm cli init`：创建 owner 与口令。已存在则报错（改口令走 passwd）。 */
  async initOwner(input: { password: string; timezone: string; displayName?: string }): Promise<Owner> {
    if (input.password.length < 8) throw new AppError("invalid_request", "口令至少 8 个字符");
    assertTimezone(input.timezone);
    const exists = await this.#db.get<{ id: string }>("SELECT id FROM app_owners LIMIT 1");
    if (exists) throw new AppError("invalid_request", "owner 已存在；修改口令请使用 passwd");
    const now = this.#clock.now();
    const id = uuidv7(now);
    const hash = await hashPassword(input.password);
    const displayName = input.displayName?.trim() || "我";
    await this.#db.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO app_owners (id, display_name, timezone, created_at) VALUES (?, ?, ?, ?)",
        id,
        displayName,
        input.timezone,
        now,
      );
      await tx.run("INSERT INTO app_auth (owner_id, password_hash, updated_at) VALUES (?, ?, ?)", id, hash, now);
    });
    return { id, displayName, timezone: input.timezone };
  }

  /** `pnpm cli passwd`：改口令，并使所有会话失效。 */
  async changePassword(newPassword: string): Promise<void> {
    if (newPassword.length < 8) throw new AppError("invalid_request", "口令至少 8 个字符");
    const row = await this.#db.get<{ owner_id: string }>("SELECT owner_id FROM app_auth LIMIT 1");
    if (!row) throw new AppError("not_found", "尚未初始化");
    const hash = await hashPassword(newPassword);
    await this.#db.transaction(async (tx) => {
      await tx.run(
        "UPDATE app_auth SET password_hash = ?, failed_count = 0, locked_until = NULL, updated_at = ? WHERE owner_id = ?",
        hash,
        this.#clock.now(),
        row.owner_id,
      );
      await tx.run("DELETE FROM app_sessions WHERE owner_id = ?", row.owner_id);
    });
  }

  /** 登录：成功返回明文 token（只出现这一次）；失败累计，连续 5 次锁 60 s。 */
  async login(password: string): Promise<{ token: string; ownerId: string; expiresAt: number }> {
    const now = this.#clock.now();
    const auth = await this.#db.get<{
      owner_id: string;
      password_hash: string;
      failed_count: number;
      locked_until: number | null;
    }>("SELECT owner_id, password_hash, failed_count, locked_until FROM app_auth LIMIT 1");
    if (!auth) throw new AppError("unauthenticated", "口令错误");
    if (auth.locked_until !== null && auth.locked_until > now) {
      throw new AppError("locked", "登录失败次数过多，请稍后再试", { retry_after_ms: auth.locked_until - now });
    }
    if (!(await verifyPassword(password, auth.password_hash))) {
      const failed = (auth.locked_until !== null && auth.locked_until <= now ? 0 : auth.failed_count) + 1;
      if (failed >= MAX_FAILURES) {
        await this.#db.run(
          "UPDATE app_auth SET failed_count = 0, locked_until = ? WHERE owner_id = ?",
          now + LOCK_MS,
          auth.owner_id,
        );
        throw new AppError("locked", "登录失败次数过多，请稍后再试", { retry_after_ms: LOCK_MS });
      }
      await this.#db.run(
        "UPDATE app_auth SET failed_count = ?, locked_until = NULL WHERE owner_id = ?",
        failed,
        auth.owner_id,
      );
      throw new AppError("unauthenticated", "口令错误");
    }
    await this.#db.run("UPDATE app_auth SET failed_count = 0, locked_until = NULL WHERE owner_id = ?", auth.owner_id);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + SESSION_TTL_MS;
    await this.#db.run(
      "INSERT INTO app_sessions (token_hash, owner_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
      sha256(token),
      auth.owner_id,
      now,
      expiresAt,
      now,
    );
    return { token, ownerId: auth.owner_id, expiresAt };
  }

  /** 校验 cookie 中的 token；过期会话顺手清除。 */
  async authenticate(token: string | undefined): Promise<Owner | undefined> {
    if (!token) return undefined;
    const now = this.#clock.now();
    const hash = sha256(token);
    const row = await this.#db.get<{ owner_id: string; expires_at: number; display_name: string; timezone: string }>(
      `SELECT s.owner_id, s.expires_at, o.display_name, o.timezone
         FROM app_sessions s JOIN app_owners o ON o.id = s.owner_id WHERE s.token_hash = ?`,
      hash,
    );
    if (!row) return undefined;
    if (row.expires_at <= now) {
      await this.#db.run("DELETE FROM app_sessions WHERE token_hash = ?", hash);
      return undefined;
    }
    await this.#db.run("UPDATE app_sessions SET last_seen_at = ? WHERE token_hash = ?", now, hash);
    return { id: row.owner_id, displayName: row.display_name, timezone: row.timezone };
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.#db.run("DELETE FROM app_sessions WHERE token_hash = ?", sha256(token));
  }
}
