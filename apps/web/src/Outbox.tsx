import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { fmtTime } from "./hooks.ts";

const LABEL = {
  pending: "待发送", dispatching: "发送中", succeeded: "已送达",
  failed: "失败", unknown: "送达未知", needs_review: "待核对",
};
const ERRORS: Record<string, string> = {
  abandoned: "已放弃", send_interrupted: "发送时服务中断", restored_snapshot: "来自恢复的备份",
  response_unknown: "无法确认送达", signature_rejected: "飞书拒绝签名", webhook_rejected: "飞书拒绝请求",
  http_rejected: "服务拒绝请求", connection_unavailable: "无法连接", rate_limited: "服务限流",
  service_unavailable: "服务暂不可用", invalid_payload: "投递数据有误",
};
type Status = keyof typeof LABEL;
type Delivery = {
  id: string; occurrence_id: string; status: Status; attempts: number;
  error_code: string | null; updated_at: number;
};
type Page = { items: Delivery[]; next_cursor: string | null };
type Action = "retry" | "succeeded" | "failed";

export function Outbox({ timezone }: { timezone: string }) {
  const [status, setStatus] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [page, setPage] = useState<Page>();
  const [refresh, setRefresh] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const cursor = cursors.at(-1);
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ limit: "20" });
    if (status) query.set("status", status);
    if (cursor) query.set("cursor", cursor);
    const load = () => {
      void api<Page>("GET", "/v1/outbox?" + query).then((value) => { if (active) setPage(value); },
        (e: Error) => { if (active) setError(e.message); });
    };
    load();
    const timer = cursor ? undefined : window.setInterval(load, 4000);
    return () => {
      active = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [status, cursor, refresh]);

  async function act(row: Delivery, action: Action) {
    if (action === "retry" && row.status === "needs_review" &&
        !window.confirm("如果飞书群已经收到，再次发送可能产生重复提醒。确认重新发送？")) return;
    setError("");
    setPending(true);
    try {
      const route = action === "retry" ? "retry" : "resolve";
      await api("POST", "/v1/outbox/" + row.id + "/" + route, action === "retry" ? undefined : { resolution: action });
      setRefresh((value) => value + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return <section className="ops-section" aria-label="外部投递">
    <div className="row">
      <h3>飞书外部投递</h3>
      <label className="right">状态 <select value={status} onChange={(e) => {
        setStatus(e.target.value); setCursors([]); setPage(undefined); setError("");
      }}>
        <option value="">全部</option>
        {Object.entries(LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {page?.items.length === 0 && <p className="muted">没有符合条件的投递。</p>}
    {!page && !error && <p className="muted">正在读取外部投递…</p>}
    {!!page?.items.length && <ul className="list col-list">
      {page.items.map((row) => <li key={row.id}>
        <div className="row">
          <strong>{row.error_code === "abandoned" ? "已放弃" : LABEL[row.status]}</strong>
          <span className="muted">{row.attempts} 次尝试</span>
          {row.error_code && <span>{ERRORS[row.error_code] ?? row.error_code}</span>}
          <time className="muted right">{fmtTime(row.updated_at, timezone)}</time>
        </div>
        <div className="muted">提醒触发 ID <code>{row.occurrence_id}</code></div>
        {row.status === "needs_review" && <p>请先核对飞书群是否收到提醒。</p>}
        <div className="row">
          {row.status === "needs_review" && <button disabled={pending} onClick={() => void act(row, "succeeded")}>标记已送达</button>}
          {(row.status === "needs_review" || row.status === "failed") &&
            <button disabled={pending} onClick={() => void act(row, "retry")}>重新发送</button>}
          {row.status === "needs_review" && <button disabled={pending} onClick={() => void act(row, "failed")}>放弃</button>}
        </div>
      </li>)}
    </ul>}
    <div className="row">
      <button disabled={!cursor || !page} onClick={() => { setPage(undefined); setCursors((values) => values.slice(0, -1)); }}>上一页</button>
      <button disabled={!page?.next_cursor} onClick={() => {
        const next = page?.next_cursor;
        if (next) { setPage(undefined); setCursors((values) => [...values, next]); }
      }}>下一页</button>
    </div>
  </section>;
}
