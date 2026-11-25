import { useCallback, useEffect, useState } from "react";
import { api, ApiError, uuid, type Memory, type MemoryRevision } from "./api.ts";
import { fmtTime } from "./hooks.ts";
import { Empty, PageHead } from "./ui.tsx";

const TABS: [string, string][] = [
  ["confirmed", "已确认"],
  ["candidate", "候选"],
  ["revoked", "已停用"],
  ["superseded", "已被取代"],
];
const KIND: Record<string, string> = { preference: "偏好", profile_fact: "个人事实", project_context: "项目背景" };

export function Memories() {
  const [tab, setTab] = useState("confirmed");
  const [items, setItems] = useState<Memory[]>([]);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    api<{ items: Memory[] }>("GET", `/v1/memories?status=${tab}`).then((r) => setItems(r.items), (e: Error) => setErr(e.message));
  }, [tab]);
  useEffect(load, [load]);
  return (
    <div className="page">
      <PageHead title="记忆" desc="助理长期记住的偏好与背景，会影响之后每一次回答。你可以随时修改或停用。" />
      <div className="seg">
        {TABS.map(([k, v]) => (
          <button key={k} className={tab === k ? "primary" : ""} onClick={() => setTab(k)}>
            {v}
          </button>
        ))}
      </div>
      {tab === "confirmed" && <AddMemory onDone={load} />}
      {err && <div className="error">{err}</div>}
      {items.length === 0 && <Empty icon="brain" title="这里还没有记忆"><div>在对话里说“记住……”，或在上方手动添加。</div></Empty>}
      <ul className="list col-list">
        {items.map((m) => (
          <MemoryRow key={m.id} m={m} reload={load} setErr={setErr} />
        ))}
      </ul>
    </div>
  );
}

function AddMemory({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [kind, setKind] = useState("preference");
  const [err, setErr] = useState("");
  return (
    <div className="card">
      <div className="row">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {Object.entries(KIND).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <input placeholder="key，如 review.verbosity" value={key} onChange={(e) => setKey(e.target.value)} />
      </div>
      <input className="wide" placeholder="内容（≤200 字）" value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="row">
        <button
          className="primary"
          disabled={!key.trim() || !value.trim()}
          onClick={() => {
            setErr("");
            api("POST", "/v1/memories", { client_request_id: uuid(), kind, key, value, scope: "global" }).then(
              () => {
                setKey("");
                setValue("");
                onDone();
              },
              (e: ApiError) => setErr(e.message),
            );
          }}
        >
          手动添加
        </button>
        {err && <span className="error">{err}</span>}
      </div>
    </div>
  );
}

function MemoryRow({ m, reload, setErr }: { m: Memory; reload: () => void; setErr: (s: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(m.value);
  const [revs, setRevs] = useState<MemoryRevision[] | null>(null);
  const act = (what: string, method = "POST") =>
    api(method, `/v1/memories/${m.id}${what ? "/" + what : ""}`).then(reload, (e: Error) => setErr(e.message));
  return (
    <li className="mem">
      <div className="row">
        <span className="tag">{KIND[m.kind] ?? m.kind}</span>
        <strong>{m.key}</strong>
        <span className="muted">
          [{m.scope}] · 来源：{m.source.kind === "manual" ? "手动" : m.source.kind === "message" ? "对话" : m.source.kind} · r{m.revision} · {fmtTime(m.updated_at)}
        </span>
      </div>
      {editing ? (
        <div className="row">
          <input className="grow" value={value} onChange={(e) => setValue(e.target.value)} />
          <button
            className="primary"
            onClick={() => {
              api("PATCH", `/v1/memories/${m.id}`, { value, expected_revision: m.revision }).then(
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
        <div>{m.value}</div>
      )}
      <div className="row">
        {m.status === "candidate" && (
          <>
            <button className="primary" onClick={() => void act("confirm")}>
              确认
            </button>
            <button onClick={() => void act("reject")}>拒绝</button>
          </>
        )}
        {(m.status === "confirmed" || m.status === "candidate") && !editing && <button onClick={() => setEditing(true)}>修改</button>}
        {m.status === "confirmed" && <button onClick={() => void act("revoke")}>停用</button>}
        {m.status === "revoked" && <button onClick={() => void act("enable")}>重新启用</button>}
        <button
          onClick={() => {
            api<{ items: MemoryRevision[] }>("GET", `/v1/memories/${m.id}/revisions`).then((r) => setRevs(r.items), (e: Error) => setErr(e.message));
          }}
        >
          历史
        </button>
        <button
          onClick={() => {
            if (confirm("彻底删除这条记忆？删除后不会再被自动提取，且无法恢复。")) void act("", "DELETE");
          }}
        >
          删除
        </button>
      </div>
      {revs && (
        <div className="refs">
          {revs.map((r) => (
            <div key={r.revision}>
              r{r.revision} · {fmtTime(r.changed_at)} · {r.changed_by} · {r.status} · {r.value}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}
