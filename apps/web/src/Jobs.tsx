import { useCallback, useEffect, useState } from "react";
import { api, type Job } from "./api.ts";
import { fmtTime, useGlobalStream } from "./hooks.ts";

const STATUS: Record<string, string> = { queued: "排队中", running: "进行中", succeeded: "已完成", failed: "失败", cancelled: "已取消" };
const KIND: Record<string, string> = { ingest_url: "抓取网页", ingest_text: "处理文本" };

export function Jobs() {
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
      <table className="table">
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td>{KIND[j.kind] ?? j.kind}</td>
              <td><span className={`pill ${j.status}`}>{STATUS[j.status] ?? j.status}</span></td>
              <td className="muted">{j.attempts}/{j.max_attempts} 次</td>
              <td className="muted">{j.error_message ?? ""}</td>
              <td className="muted">{fmtTime(j.updated_at)}</td>
              <td>
                {j.document_id && <a href={`#/docs/${j.document_id}`}>资料</a>}{" "}
                {j.status === "failed" && <button onClick={() => act(j.id, "retry")}>重试</button>}
                {(j.status === "queued" || j.status === "running") && <button onClick={() => act(j.id, "cancel")}>取消</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
