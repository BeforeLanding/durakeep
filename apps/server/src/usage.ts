import { AppError, uuidv7, type Clock, type RuntimePort, type UsageSummary } from "@durakeep/core";
import type { SqlDatabase, SqlExecutor } from "@durakeep/db";
import type { EventHub } from "./hub.ts";
import { readBudget, readSetting, writeSetting } from "./settings.ts";

type Counters = { input: number; output: number; cacheRead: number; cost: number };
type MonthlyRow = { model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cost_usd: number };
const ZERO: Counters = { input: 0, output: 0, cacheRead: 0, cost: 0 };
const PRICES: ReadonlyMap<string, readonly [number, number, number]> = new Map([
  ["deepseek/deepseek-flash", [0.3, 1.2, 0.006]],
  ["deepseek/deepseek-v4-pro", [1.32, 3.96, 0.044]],
]);
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const monthAt = (now: number) => new Date(now).toISOString().slice(0, 7);
const finite = (n: number) => Number.isFinite(n) && n > 0 ? n : 0;
export const BUDGET_WARNING = "本月模型费用已达到预算上限。后台模型作业已暂停，你仍可继续对话。";

async function readReport(db: SqlExecutor, ownerId: string, month: string) {
  const models = await db.all<MonthlyRow>(
    "SELECT model, input_tokens, output_tokens, cache_read_tokens, cost_usd FROM app_usage_monthly WHERE owner_id = ? AND month = ? ORDER BY model",
    ownerId, month,
  );
  const budget = await readBudget(db, ownerId);
  const total = models.reduce((sum, row) => sum + row.cost_usd, 0);
  const ratio = Math.min(total / budget, Number.MAX_VALUE);
  // 允许浮点累加的舍入误差，百分比仍返回原始计算结果。
  return {
    month, models, total_cost_usd: total, monthly_budget_usd: budget, usage_ratio: ratio,
    warning_80: ratio >= 0.8 - Number.EPSILON,
    exceeded_100: ratio >= 1 - Number.EPSILON,
  };
}

type Notice = { id: string; title: string; body: string };

export class UsageMeter {
  readonly #db: SqlDatabase;
  readonly #clock: Clock;
  readonly #usage: RuntimePort["usage"];
  readonly #hub: EventHub;
  readonly #onGate: (ownerId: string, paused: boolean) => void;
  readonly #paused = new Map<string, boolean>();
  #chain: Promise<unknown> = Promise.resolve();

  constructor(db: SqlDatabase, clock: Clock, usage: RuntimePort["usage"], hub: EventHub, onGate: (ownerId: string, paused: boolean) => void = () => {}) {
    this.#db = db;
    this.#clock = clock;
    this.#usage = usage;
    this.#hub = hub;
    this.#onGate = onGate;
  }

  warning(ownerId: string): string | null {
    return this.#paused.get(ownerId) ? BUDGET_WARNING : null;
  }

  /** Harness 是单 owner 的全库累计量。升级时以现有快照起步，避免把无法分月的历史旧账计入当月。 */
  sync(ownerId: string, initialize = false): ReturnType<typeof readReport> {
    const next = this.#chain.then(async () => {
      const now = this.#clock.now();
      const usage = await this.#usage();
      const { report, notices, unread } = await this.#db.transaction(async (tx) => {
        await postDeltas(tx, ownerId, now, usage, initialize);
        const report = await readReport(tx, ownerId, monthAt(now));
        const notices: Notice[] = [];
        if (report.warning_80) {
          await insertNotice(tx, notices, ownerId, now, 80, "模型预算提醒", "本月模型费用已达到预算的 80%。");
        }
        if (report.exceeded_100) await insertNotice(tx, notices, ownerId, now, 100, "模型预算已用尽", BUDGET_WARNING);
        const unread = notices.length ? await tx.get<{ count: number }>(
          "SELECT COUNT(*) AS count FROM app_notifications WHERE owner_id = ? AND read_at IS NULL", ownerId,
        ) : undefined;
        return { report, notices, unread };
      });
      for (const notice of notices) this.#hub.publish({ ownerId, event: "notification", data: { ...notice, kind: "system", link: null } });
      if (unread) this.#hub.publish({ ownerId, event: "unread", data: unread });
      if (this.#paused.get(ownerId) !== report.exceeded_100) {
        this.#paused.set(ownerId, report.exceeded_100);
        this.#hub.publish({ ownerId, event: "budget", data: { budget_warning: this.warning(ownerId) } });
      }
      this.#onGate(ownerId, report.exceeded_100);
      return report;
    });
    this.#chain = next.catch(() => {});
    return next;
  }

  async get(ownerId: string, month?: string): ReturnType<typeof readReport> {
    if (month !== undefined && !MONTH.test(month)) {
      throw new AppError("invalid_request", "month 需为 YYYY-MM", { issues: [{ path: "month" }] });
    }
    const current = await this.sync(ownerId);
    if (month === undefined || month === current.month) return current;
    return this.#db.transaction((tx) => readReport(tx, ownerId, month));
  }

  /** 按分钟同步，并在 UTC 换月边界立即重估闸门。 */
  start(ownerId: string, onError: (e: unknown) => void): () => Promise<void> {
    let stopped = false;
    let cancel: (() => void) | undefined;
    let running: Promise<unknown> | undefined;
    const arm = () => {
      if (stopped) return;
      const now = this.#clock.now();
      const date = new Date(now);
      const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
      cancel = this.#clock.setTimer(() => {
        running = this.sync(ownerId).catch(onError).finally(arm);
      }, Math.min(60_000, nextMonth - now));
    };
    arm();
    return async () => {
      stopped = true;
      cancel?.();
      await running;
    };
  }
}

async function postDeltas(tx: SqlExecutor, ownerId: string, now: number, usage: UsageSummary, initialize: boolean) {
  const key = `usage_baseline:${ownerId}`;
  const stored = await readSetting(tx, key) as Record<string, Counters> | undefined;
  const baselines = new Map(Object.entries(stored ?? {}));
  const seed = initialize && stored === undefined;
  let changed = stored === undefined;
  for (const [model, u] of Object.entries(usage.models)) {
    const old = baselines.get(model) ?? ZERO;
    const input = Math.max(0, finite(u.input) - old.input);
    const output = Math.max(0, finite(u.output) - old.output);
    const cacheRead = Math.max(0, finite(u.cacheRead) - old.cacheRead);
    const reported = Math.max(0, finite(u.cost.total) - old.cost);
    if (input === 0 && output === 0 && cacheRead === 0 && reported === 0) continue;
    changed = true;
    baselines.set(model, { input: old.input + input, output: old.output + output, cacheRead: old.cacheRead + cacheRead, cost: old.cost + reported });
    if (seed) continue;
    const rate = PRICES.get(model);
    const estimated = rate ? (input * rate[0] + output * rate[1] + cacheRead * rate[2]) / 1_000_000 : 0;
    await tx.run(
      `INSERT INTO app_usage_monthly (owner_id, month, model, input_tokens, output_tokens, cache_read_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, month, model) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
         cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens, cost_usd = cost_usd + excluded.cost_usd`,
      ownerId, monthAt(now), model, input, output, cacheRead, reported || estimated,
    );
  }
  if (changed) await writeSetting(tx, key, Object.fromEntries(baselines), now);
}

async function insertNotice(tx: SqlExecutor, notices: Notice[], ownerId: string, now: number, threshold: 80 | 100, title: string, body: string) {
  const inserted = await tx.get<Notice>(
    `INSERT INTO app_notifications (id, owner_id, dedupe_key, kind, title, body, created_at)
     VALUES (?, ?, ?, 'system', ?, ?, ?) ON CONFLICT(owner_id, dedupe_key) DO NOTHING RETURNING id, title, body`,
    uuidv7(now), ownerId, `budget:${threshold}:${monthAt(now)}`, title, body, now,
  );
  if (inserted) notices.push(inserted);
}
