import { useCallback, useEffect, useState } from "react";
import { Account } from "./Account.tsx";
import { api, uuid, type Me } from "./api.ts";
import { fmtTime, useGlobalStream } from "./hooks.ts";

type Preferences = { chat_model: string; monthly_budget_usd: number; timezone: string; backup_keep: number };
type Health = {
  uptime_ms: number; db_size_bytes: number; queued_jobs: number; failed_jobs: number; unread_notifications: number;
  last_backup_at: number | null; pi_reports: { total: number; by_kind: Record<string, number> };
  delivery_paused: boolean; orphaned_background_conversations: number;
  feishu_configured: boolean; outbox_pending: number; outbox_needs_review: number;
};
type Usage = {
  month: string; monthly_budget_usd: number; total_cost_usd: number; usage_ratio: number; warning_80: boolean; exceeded_100: boolean;
  models: { model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cost_usd: number }[];
};
const usd = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD", maximumFractionDigits: 6 });
const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });

export function Settings({ me, onMe, timezone, onTimezone }: { me: Me; onMe: (me: Me) => void; timezone: string; onTimezone: (timezone: string) => void }) {
  const [health, setHealth] = useState<Health>();
  const [usage, setUsage] = useState<Usage>();
  const [preferences, setPreferences] = useState<Preferences>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const refresh = useCallback(async () => {
    const [status, monthly] = await Promise.all([
      api<Health>("GET", "/v1/admin/health"), api<Usage>("GET", "/v1/usage"),
    ]);
    setHealth(status);
    setUsage(monthly);
  }, []);
  const refreshStatus = useCallback(() => {
    void refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);
  useEffect(() => {
    void api<Preferences>("GET", "/v1/settings").then(setPreferences, (e: Error) => setError(e.message));
    refreshStatus();
    const timer = window.setInterval(refreshStatus, 15_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);
  useGlobalStream((ev, data) => {
    if (ev === "job" && (data as { kind?: string }).kind === "backup") refreshStatus();
  });

  async function perform(task: () => Promise<string>) {
    setPending(true);
    setFeedback("");
    setError("");
    try {
      setFeedback(await task());
      refreshStatus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="page ops">
      <header className="ops-header"><h2>设置 / 健康</h2><a href="/v1/admin/runbook" target="_blank" rel="noreferrer">运维与升级手册</a></header>
      {error ? <p role="alert" className="error">{error}</p> : null}
      {feedback ? <p role="status" className="ok">{feedback}</p> : null}

      <Account me={me} onMe={onMe} />

      {health?.delivery_paused ? (
        <div className="banner ops-pause" role="status">
          <strong>提醒投递已暂停。核对恢复数据后再恢复投递。</strong>
          <button disabled={pending} onClick={() => {
            if (window.confirm("已核对恢复的数据，并允许补发到期提醒？")) void perform(async () => {
              await api("POST", "/v1/admin/delivery/resume");
              return "已恢复提醒投递。";
            });
          }}>恢复投递</button>
        </div>
      ) : null}

      <section className="ops-section">
        <h3>运行状态</h3>
        {health ? <>
          <dl className="ops-metrics">
            <div><dt>运行时长</dt><dd>{Math.floor(health.uptime_ms / 3600000)} 小时 {Math.floor(health.uptime_ms / 60000) % 60} 分钟 {Math.floor(health.uptime_ms / 1000) % 60} 秒</dd></div>
            <div><dt>数据库逻辑大小</dt><dd>{health.db_size_bytes.toLocaleString()} 字节</dd></div>
            <div><dt>排队作业</dt><dd>{health.queued_jobs}</dd></div>
            <div><dt>失败作业</dt><dd className={health.failed_jobs ? "error" : ""}>{health.failed_jobs}</dd></div>
            <div><dt>未读通知</dt><dd>{health.unread_notifications}</dd></div>
            <div><dt>最近备份</dt><dd>{health.last_backup_at === null ? "暂无" : <time title={new Date(health.last_backup_at).toISOString()}>{fmtTime(health.last_backup_at, timezone)}</time>}</dd></div>
            <div><dt>提醒投递</dt><dd>{health.delivery_paused ? "暂停" : "正常"}</dd></div>
            <div><dt>孤儿后台会话</dt><dd>{health.orphaned_background_conversations}</dd></div>
            <div><dt>飞书机器人</dt><dd>{health.feishu_configured ? "已配置" : "未配置"}</dd></div>
            <div><dt>飞书文档导入</dt><dd title="FEISHU_APP_ID / FEISHU_APP_SECRET">{me.capabilities?.feishu_docs ? "已配置" : "未配置"}</dd></div>
            <div><dt>飞书待发送</dt><dd>{health.outbox_pending}</dd></div>
            <div><dt>飞书待核对</dt><dd><a href="#/jobs">{health.outbox_needs_review}</a></dd></div>
          </dl>
          <details className="ops-reports" open={(health.pi_reports.by_kind.storage_failed ?? 0) > 0}>
            <summary className={health.pi_reports.by_kind.storage_failed ? "error" : ""}>Pi 报告 {health.pi_reports.total} 条</summary>
            {health.pi_reports.total ? <ul>{Object.entries(health.pi_reports.by_kind).map(([kind, count]) => <li key={kind}>{kind} · {count}</li>)}</ul> : <p className="muted">暂无报告。</p>}
          </details>
        </> : <p className="muted">正在读取运行状态…</p>}
        <div className="row ops-actions">
          <button className="primary" disabled={pending} onClick={() => void perform(async () => {
            await api("POST", "/v1/admin/backup", { client_request_id: uuid() });
            return "备份已入队，可在任务页查看进度。";
          })}>立即备份</button>
          <a href="/v1/export" download>导出数据 (ZIP)</a>
        </div>
      </section>

      <section className="ops-section">
        <h3>本月用量</h3>
        {usage ? <>
          <div className="ops-budget"><strong>{usd.format(usage.total_cost_usd)}</strong><span className="muted"> / {usd.format(usage.monthly_budget_usd)} · {usage.month} UTC</span></div>
          <progress max={1} value={Math.min(1, usage.usage_ratio)} aria-label="本月预算使用比例" />
          <p className={usage.exceeded_100 ? "error" : "muted"}>{percent.format(usage.usage_ratio)}{usage.exceeded_100 ? " · 预算用尽，后台模型作业已暂停" : usage.warning_80 ? " · 已达到预算预警线" : ""}</p>
          {usage.models.length ? <div className="ops-table">
            <table className="table">
              <thead><tr><th>模型</th><th>输入</th><th>输出</th><th>缓存读</th><th>费用</th></tr></thead>
              <tbody>{usage.models.map((row) => <tr key={row.model}><td>{row.model}</td><td>{row.input_tokens.toLocaleString()}</td><td>{row.output_tokens.toLocaleString()}</td><td>{row.cache_read_tokens.toLocaleString()}</td><td>{usd.format(row.cost_usd)}</td></tr>)}</tbody>
            </table>
          </div> : <p className="muted">本月暂无用量。</p>}
        </> : <p className="muted">正在读取用量…</p>}
      </section>

      <section className="ops-section">
        <h3>偏好设置</h3>
        {preferences ? <form onSubmit={(e) => {
          e.preventDefault();
          const input = new FormData(e.currentTarget);
          void perform(async () => {
            const saved = await api<Preferences>("PATCH", "/v1/settings", {
              chat_model: input.get("chat_model"), monthly_budget_usd: Number(input.get("monthly_budget_usd")),
              timezone: input.get("timezone"), backup_keep: Number(input.get("backup_keep")),
            });
            setPreferences(saved);
            onTimezone(saved.timezone);
            return "设置已保存。";
          });
        }}>
          <div className="ops-fields">
            <label>新对话模型<select name="chat_model" defaultValue={preferences.chat_model}><option value="deepseek-flash">DeepSeek Flash</option><option value="deepseek-v4-pro">DeepSeek V4 Pro</option></select></label>
            <label>月度预算 (USD)<input name="monthly_budget_usd" type="number" step="any" required defaultValue={preferences.monthly_budget_usd} /></label>
            <label>时区<input name="timezone" placeholder="Asia/Shanghai" required defaultValue={preferences.timezone} /></label>
            <label>备份保留份数<input name="backup_keep" type="number" min="1" step="1" required defaultValue={preferences.backup_keep} /></label>
          </div>
          <button className="primary" disabled={pending}>保存设置</button>
        </form> : <p className="muted">正在读取设置…</p>}
      </section>
    </div>
  );
}
