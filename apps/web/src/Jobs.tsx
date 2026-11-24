import { useCallback, useEffect, useState } from "react";
import { api, type Job } from "./api.ts";
import { fmtTime, useGlobalStream } from "./hooks.ts";

const STATUS: Record<string, string> = { queued: "排队中", running: "进行中", succeeded: "已完成", failed: "失败", cancelled: "已取消" };
const KIND: Record<string, string> = {
  ingest_url: "抓取网页", ingest_text: "处理文本", summarize: "生成摘要",
  extract_memory: "提取候选记忆", purge_document: "彻底删除资料", backup: "备份",
};
const EVENT: Record<string, string> = {
  "pi.storage_failed": "运行时存储故障", "pi.task_faulted": "运行时任务中断", "pi.task_blocked": "运行时任务受阻",
  "pi.extension_error": "运行时扩展报告", "job.failed": "作业失败", "backup.done": "备份完成", "backup.failed": "备份失败",
  "recovery.scan": "启动恢复扫描", "profile.truncated": "全局记忆已截断",
};
const LEVEL: Record<string, string> = { info: "信息", warn: "警告", error: "错误" };
type EventPage = {
  items: { id: string; kind: string; level: string; message: string; created_at: number; ref: Record<string, string | number> }[];
  next_cursor: string | null;
};

export function Jobs({ timezone }: { timezone: string }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    api<{ items: Job[] }>("GET", "/v1/jobs?limit=100").then((r) => setJobs(r.items), (e: Error) => setErr(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const t = setInterval(load, 4000); // 兜底：运行中的作业没有进度事件
    return () => clearInterval(t);
  }, [load]);
  useGlobalStream((ev) => ev === "job" && load());
  const act = (id: string, what: "retry" | "cancel") => api("POST", `/v1/jobs/${id}/${what}`).then(load, (e: Error) => setErr(e.message));
  return (
    <div className="page">
      <h2>任务</h2>
      {err && <div className="error">{err}</div>}
      {jobs.length === 0 && <div className="muted">没有任务。</div>}
      <div className="ops-table"><table className="table">
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>{KIND[j.kind] ?? j.kind}</td>
              <td><span className={`pill ${j.status}`}>{STATUS[j.status] ?? j.status}</span></td>
              <td className="muted">{j.attempts}/{j.max_attempts} 次</td>
              <td className="muted">{j.error_message ?? ""}</td>
              <td className="muted"><time title={new Date(j.updated_at).toISOString()}>{fmtTime(j.updated_at, timezone)}</time></td>
              <td>
                {j.document_id && <a href={`#/docs/${j.document_id}`}>资料</a>}{" "}
                {j.status === "failed" && <button onClick={() => act(j.id, "retry")}>重试</button>}
                {(j.status === "queued" || j.status === "running") && <button onClick={() => act(j.id, "cancel")}>取消</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <EventsPanel timezone={timezone} />
    </div>
  );
}

function EventsPanel({ timezone }: { timezone: string }) {
  const [level, setLevel] = useState("");
  const [cursors, setCursors] = useState<string[]>([]);
  const [page, setPage] = useState<EventPage>();
  const [error, setError] = useState("");
  const cursor = cursors.at(-1);
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ limit: "20" });
    if (level) query.set("level", level);
    if (cursor) query.set("cursor", cursor);
    function load() {
      void api<EventPage>("GET", `/v1/events?${query}`).then((result) => {
        if (!active) return;
        setPage(result);
        setError("");
      }, (e: Error) => {
        if (active) setError(e.message);
      });
    }
    load();
    const timer = cursor ? undefined : window.setInterval(load, 4000);
    return () => {
      active = false;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [level, cursor]);

  return <section className="ops-section">
    <div className="row">
      <h3>运行报告 / 运维事件</h3>
      <label className="right">级别 <select value={level} onChange={(e) => {
        setLevel(e.target.value);
        setCursors([]);
        setPage(undefined);
      }}><option value="">全部</option><option value="info">信息</option><option value="warn">警告</option><option value="error">错误</option></select></label>
    </div>
    {error ? <p className="error" role="alert">{error}</p> : null}
    {page?.items.length === 0 ? <p className="muted">没有符合条件的事件。</p> : null}
    {page ? <ul className="list col-list">
      {page.items.map((event) => <li key={event.id}>
        <div className="row">
          <span className={`pill ${event.level === "error" ? "failed" : ""}`}>{LEVEL[event.level] ?? event.level}</span>
          <strong>{EVENT[event.kind] ?? event.kind}</strong>
          <code>{event.message}</code>
          <time className="muted right" title={new Date(event.created_at).toISOString()}>{fmtTime(event.created_at, timezone)}</time>
        </div>
        {event.kind === "pi.task_blocked" ? <p>任务需要兼容的定义或迁移。<a href="/v1/admin/runbook" target="_blank" rel="noreferrer">查看升级手册</a></p> : null}
        {event.ref.task_id || event.ref.job_id ? <div className="muted">任务 ID <code>{event.ref.task_id ?? event.ref.job_id}</code></div> : null}
      </li>)}
    </ul> : !error ? <p className="muted">正在读取事件…</p> : null}
    <div className="row">
      <button disabled={!cursor || !page} onClick={() => { setPage(undefined); setCursors((previous) => previous.slice(0, -1)); }}>上一页</button>
      <button disabled={!page?.next_cursor} onClick={() => {
        const next = page?.next_cursor;
        if (next) { setPage(undefined); setCursors((previous) => [...previous, next]); }
      }}>下一页</button>
    </div>
  </section>;
}
