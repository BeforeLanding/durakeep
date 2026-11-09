import { useCallback, useEffect, useState } from "react";
import { api, ApiError, uuid, type Reminder } from "./api.ts";
import { fmtTime, useGlobalStream } from "./hooks.ts";

const STATUS: Record<string, string> = { active: "进行中", fired: "已触发", cancelled: "已取消" };

export function Reminders({ timezone }: { timezone: string }) {
  const [status, setStatus] = useState("active");
  const [items, setItems] = useState<Reminder[]>([]);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    api<{ items: Reminder[] }>("GET", `/v1/reminders?status=${status}`).then((r) => setItems(r.items), (e: Error) => setErr(e.message));
  }, [status]);
  useEffect(load, [load]);
  useGlobalStream((ev) => ev === "notification" && load());
  return (
    <div className="page">
      <h2>提醒</h2>
      <Create timezone={timezone} onDone={load} />
      <div className="row">
        {Object.entries(STATUS).map(([k, v]) => (
          <button key={k} className={status === k ? "primary" : ""} onClick={() => setStatus(k)}>
            {v}
          </button>
        ))}
      </div>
      {err && <div className="error">{err}</div>}
      {items.length === 0 && <div className="muted">没有提醒。</div>}
      <ul className="list col-list">
        {items.map((r) => (
          <Row key={r.id} r={r} reload={load} setErr={setErr} />
        ))}
      </ul>
    </div>
  );
}

function Create({ timezone, onDone }: { timezone: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const [when, setWhen] = useState("");
  const [tz, setTz] = useState(timezone);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="card">
      <input className="wide" placeholder="提醒内容" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        <input value={tz} onChange={(e) => setTz(e.target.value)} title="IANA 时区，如 Asia/Shanghai" />
        <button
          className="primary"
          disabled={!text.trim() || !when}
          onClick={() => {
            setMsg(null);
            api<Reminder>("POST", "/v1/reminders", { client_request_id: uuid(), text, local_datetime: when.slice(0, 16), timezone: tz }).then(
              (r) => {
                setMsg({ ok: true, text: `已创建：${r.local}（${r.timezone}）` });
                setText("");
                onDone();
              },
              (e: ApiError) => setMsg({ ok: false, text: e.message }),
            );
          }}
        >
          创建提醒
        </button>
      </div>
      {msg && <div className={msg.ok ? "ok" : "error"}>{msg.text}</div>}
    </div>
  );
}

function Row({ r, reload, setErr }: { r: Reminder; reload: () => void; setErr: (s: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(r.text);
  const [when, setWhen] = useState(r.local_datetime);
  return (
    <li className="mem">
      {editing ? (
        <div className="row">
          <input className="grow" value={text} onChange={(e) => setText(e.target.value)} />
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          <button
            className="primary"
            onClick={() => {
              api("PATCH", `/v1/reminders/${r.id}`, { text, local_datetime: when.slice(0, 16), expected_revision: r.revision }).then(
                () => {
                  setEditing(false);
                  reload();
                },
                (e: Error) => setErr(e.message),
              );
            }}
          >
            保存
          </button>
          <button onClick={() => setEditing(false)}>取消</button>
        </div>
      ) : (
        <div className="row">
          <strong>{r.text}</strong>
          <span className="muted">
            {r.local}（{r.timezone}）
          </span>
          <span className={`pill ${r.status === "fired" ? "ready" : ""}`}>{STATUS[r.status] ?? r.status}</span>
          {r.last_occurrence && (
            <span className="muted">
              触发于 {fmtTime(r.last_occurrence.fired_at)}
              {r.last_occurrence.late_ms >= 120_000 ? `（迟到 ${Math.round(r.last_occurrence.late_ms / 60_000)} 分钟）` : ""}
            </span>
          )}
        </div>
      )}
      {r.status === "active" && !editing && (
        <div className="row">
          <button onClick={() => setEditing(true)}>修改</button>
          <button
            onClick={() => {
              api("POST", `/v1/reminders/${r.id}/cancel`).then(reload, (e: Error) => setErr(e.message));
            }}
          >
            取消提醒
          </button>
        </div>
      )}
    </li>
  );
}
