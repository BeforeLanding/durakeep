import { createHash, randomBytes } from "node:crypto";
import { AppError, uuidv7, type Clock } from "@durakeep/core";
import type { SqlDatabase } from "@durakeep/db";
import { hashPassword, verifyPassword } from "./password.ts";

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // FR-AUTH-01
export const MAX_FAILURES = 5; // S2
export const LOCK_MS = 60_000; // S2
/** 未勾选“保持登录”：浏览器会话 cookie，服务端 12 小时后过期，不续期。 */
export const SHORT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type SessionInfo = {
  id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  device: string;
  persistent: boolean;
  current: boolean;
};

/** 只保存“浏览器 · 系统”这样的摘要，不存完整 User-Agent。 */
export function describeAgent(ua: string | undefined): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl\//i.test(ua) ? "curl" : "浏览器";
  const os = /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} · ${os}` : browser;
}

const COMMON_WEAK = new Set(["password", "password1", "12345678", "123456789", "qwertyui", "qwerty123", "iloveyou", "11111111", "abc12345"]);

/** 口令强度：8–256 个字符，且不能是单字符重复、顺序串或常见弱口令这类一眼可猜的口令。 */
export function assertStrongEnough(password: string): void {
  if (password.length < 8) throw new AppError("invalid_request", "口令至少 8 个字符", { issues: [{ path: "password" }] });
  if (password.length > 256) throw new AppError("invalid_request", "口令最多 256 个字符", { issues: [{ path: "password" }] });
  const lower = password.toLowerCase();
  const weak = /^(.)\1+$/.test(password) || "01234567890123456789".includes(password) || "abcdefghijklmnopqrstuvwxyz".includes(lower) || COMMON_WEAK.has(lower);
  if (weak) throw new AppError("invalid_request", "这个口令太容易被猜到了，换一个吧", { issues: [{ path: "password" }] });
}

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

  async isInitialized(): Promise<boolean> {
    return (await this.#db.get<{ id: string }>("SELECT id FROM app_owners LIMIT 1")) !== undefined;
  }

  /** 登录：成功返回明文 token（只出现这一次）；失败累计，连续 5 次锁 60 s。remember=false 时会话 12 小时、不续期。 */
  async login(
    password: string,
    opts: { remember?: boolean; userAgent?: string } = {},
  ): Promise<{ token: string; ownerId: string; expiresAt: number; persistent: boolean }> {
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
      throw new AppError("unauthenticated", "口令错误", { attempts_left: MAX_FAILURES - failed });
    }
    await this.#db.run("UPDATE app_auth SET failed_count = 0, locked_until = NULL WHERE owner_id = ?", auth.owner_id);
    return this.#issue(auth.owner_id, now, opts.remember !== false, opts.userAgent);
  }

  async #issue(ownerId: string, now: number, persistent: boolean, userAgent: string | undefined) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + (persistent ? SESSION_TTL_MS : SHORT_SESSION_TTL_MS);
    await this.#db.run(
      "INSERT INTO app_sessions (token_hash, owner_id, created_at, expires_at, last_seen_at, user_agent, persistent) VALUES (?, ?, ?, ?, ?, ?, ?)",
      sha256(token),
      ownerId,
      now,
      expiresAt,
      now,
      describeAgent(userAgent),
      persistent ? 1 : 0,
    );
    return { token, ownerId, expiresAt, persistent };
  }

  /** 首次设置（网页）：创建 owner 后直接签发会话。 */
  async setup(input: { password: string; timezone: string; displayName?: string; userAgent?: string }) {
    assertStrongEnough(input.password);
    const owner = await this.initOwner(input);
    return this.#issue(owner.id, this.#clock.now(), true, input.userAgent);
  }

  /** 网页改口令：先校验当前口令；成功后注销其他所有会话，保留当前会话。 */
  async changePasswordVerified(ownerId: string, current: string, next: string, keepToken: string | undefined): Promise<void> {
    const auth = await this.#db.get<{ password_hash: string }>("SELECT password_hash FROM app_auth WHERE owner_id = ?", ownerId);
    if (!auth || !(await verifyPassword(current, auth.password_hash))) {
      throw new AppError("invalid_request", "当前口令不正确", { issues: [{ path: "current_password" }] });
    }
    if (current === next) throw new AppError("invalid_request", "新口令不能与当前口令相同", { issues: [{ path: "new_password" }] });
    assertStrongEnough(next);
    const hash = await hashPassword(next);
    const keep = keepToken ? sha256(keepToken) : "";
    await this.#db.transaction(async (tx) => {
      await tx.run("UPDATE app_auth SET password_hash = ?, failed_count = 0, locked_until = NULL, updated_at = ? WHERE owner_id = ?", hash, this.#clock.now(), ownerId);
      await tx.run("DELETE FROM app_sessions WHERE owner_id = ? AND token_hash != ?", ownerId, keep);
    });
  }

  async updateProfile(ownerId: string, displayName: unknown): Promise<string> {
    if (typeof displayName !== "string") throw new AppError("invalid_request", "display_name 必须是字符串", { issues: [{ path: "display_name" }] });
    // eslint-disable-next-line no-control-regex -- 有意剔除控制字符
    const name = displayName.replace(/[\u0000-\u001F\u007F]/g, "").trim();
    if (name === "" || Array.from(name).length > 40) throw new AppError("invalid_request", "名字需为 1–40 个字符", { issues: [{ path: "display_name" }] });
    await this.#db.run("UPDATE app_owners SET display_name = ? WHERE id = ?", name, ownerId);
    return name;
  }

  /** 会话列表：对外的 id 是 token 哈希的前 16 位（哈希本身也推不出 token）。 */
  async listSessions(ownerId: string, currentToken: string | undefined): Promise<SessionInfo[]> {
    const cur = currentToken ? sha256(currentToken) : "";
    const rows = await this.#db.all<{ token_hash: string; created_at: number; last_seen_at: number; expires_at: number; user_agent: string | null; persistent: number }>(
      "SELECT token_hash, created_at, last_seen_at, expires_at, user_agent, persistent FROM app_sessions WHERE owner_id = ? AND expires_at > ? ORDER BY last_seen_at DESC",
      ownerId,
      this.#clock.now(),
    );
    return rows.map((r) => ({
      id: r.token_hash.slice(0, 16),
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
      expires_at: r.expires_at,
      device: r.user_agent ?? "未知设备",
      persistent: r.persistent === 1,
      current: r.token_hash === cur,
    }));
  }

  async revokeSession(ownerId: string, id: string): Promise<void> {
    if (!/^[0-9a-f]{16}$/.test(id)) throw new AppError("not_found", "会话不存在");
    const before = await this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM app_sessions WHERE owner_id = ? AND substr(token_hash, 1, 16) = ?", ownerId, id);
    if (!before || before.n === 0) throw new AppError("not_found", "会话不存在");
    await this.#db.run("DELETE FROM app_sessions WHERE owner_id = ? AND substr(token_hash, 1, 16) = ?", ownerId, id);
  }

  async revokeOthers(ownerId: string, currentToken: string | undefined): Promise<void> {
    await this.#db.run("DELETE FROM app_sessions WHERE owner_id = ? AND token_hash != ?", ownerId, currentToken ? sha256(currentToken) : "");
  }

  /** 校验 cookie 中的 token；过期会话顺手清除。持久会话活跃使用时滑动续期（剩余不足一半时延长）。 */
  async authenticate(token: string | undefined): Promise<Owner | undefined> {
    if (!token) return undefined;
    const now = this.#clock.now();
    const hash = sha256(token);
    const row = await this.#db.get<{ owner_id: string; expires_at: number; persistent: number; display_name: string; timezone: string }>(
      `SELECT s.owner_id, s.expires_at, s.persistent, o.display_name, o.timezone
         FROM app_sessions s JOIN app_owners o ON o.id = s.owner_id WHERE s.token_hash = ?`,
      hash,
    );
    if (!row) return undefined;
    if (row.expires_at <= now) {
      await this.#db.run("DELETE FROM app_sessions WHERE token_hash = ?", hash);
      return undefined;
    }
    const extend = row.persistent === 1 && row.expires_at - now < SESSION_TTL_MS / 2;
    await this.#db.run(
      "UPDATE app_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?",
      now,
      extend ? now + SESSION_TTL_MS : row.expires_at,
      hash,
    );
    return { id: row.owner_id, displayName: row.display_name, timezone: row.timezone };
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.#db.run("DELETE FROM app_sessions WHERE token_hash = ?", sha256(token));
  }
}
