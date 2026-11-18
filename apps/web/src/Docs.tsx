import { useCallback, useEffect, useState } from "react";
import { api, ApiError, uuid, type Doc, type Version } from "./api.ts";
import { fmtTime, useGlobalStream } from "./hooks.ts";

const STATUS: Record<string, string> = { pending: "处理中", ready: "可用", revoked: "已停用", failed: "失败", purging: "删除中" };

const parseTags = (s: string) => [...new Set(s.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean))];

export function Docs({ docId }: { docId: string | undefined }) {
  return docId ? <Detail id={docId} /> : <List />;
}

function List() {
  const [items, setItems] = useState<Doc[]>([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (status) qs.set("status", status);
    api<{ items: Doc[] }>("GET", `/v1/documents?${qs}`).then((r) => setItems(r.items), (e: Error) => setErr(e.message));
  }, [q, status]);
  useEffect(load, [load]);
  useGlobalStream((ev) => ev === "job" && load());
  return (
    <div className="page">
      <h2>资料</h2>
      <Capture onDone={load} />
      <div className="row">
        <input placeholder="按标题前缀筛选" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {err && <div className="error">{err}</div>}
      {items.length === 0 && <div className="muted">还没有资料。</div>}
      <ul className="list">
        {items.map((d) => (
          <li key={d.id}>
            <a href={`#/docs/${d.id}`}>{d.title}</a>
            <span className={`pill ${d.status}`}>{STATUS[d.status] ?? d.status}</span>
            {d.tags.map((t) => <span key={t} className="tag">{t}</span>)}
            <span className="muted grow right">{d.source_type === "url" ? "网页" : "文本"} · {fmtTime(d.created_at)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Capture({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<"url" | "text" | "file">("url");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [tags, setTags] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const rid = uuid();
      const tagList = parseTags(tags);
      let r: { deduplicated: boolean };
      if (mode === "file") {
        if (!file) return;
        const f = new FormData();
        f.set("file", file);
        f.set("client_request_id", rid);
        f.set("tags", JSON.stringify(tagList));
        r = await api("POST", "/v1/documents", f);
      } else if (mode === "url") {
        r = await api("POST", "/v1/documents", { client_request_id: rid, type: "url", url: url.trim(), tags: tagList });
      } else {
        r = await api("POST", "/v1/documents", { client_request_id: rid, type: "text", ...(title.trim() ? { title: title.trim() } : {}), text, tags: tagList });
      }
      setMsg({ ok: true, text: r.deduplicated ? "这份资料已经收藏过了" : "已提交，正在处理（见任务页）" });
      setUrl("");
      setTitle("");
      setText("");
      setFile(null);
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : "提交失败" });
    } finally {
      setBusy(false);
    }
  };
  const ready = mode === "url" ? url.trim() !== "" : mode === "text" ? text.trim() !== "" : file !== null;
  return (
    <div className="card">
      <div className="row">
        {(["url", "text", "file"] as const).map((m) => (
          <button key={m} className={mode === m ? "primary" : ""} onClick={() => setMode(m)}>
            {m === "url" ? "网页链接" : m === "text" ? "粘贴文本" : "上传文件"}
          </button>
        ))}
      </div>
      {mode === "url" && <input className="wide" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />}
      {mode === "text" && (
        <>
          <input className="wide" placeholder="标题（可选）" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea className="wide" rows={5} placeholder="正文（≤50 万字符）" value={text} onChange={(e) => setText(e.target.value)} />
        </>
      )}
      {mode === "file" && <input type="file" accept=".md,.markdown,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
      <div className="row">
        <input placeholder="标签（逗号或空格分隔，≤10 个）" value={tags} onChange={(e) => setTags(e.target.value)} />
        <button className="primary" disabled={busy || !ready} onClick={() => void submit()}>收藏</button>
      </div>
      {msg && <div className={msg.ok ? "ok" : "error"}>{msg.text}</div>}
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const [d, setD] = useState<(Doc & { versions: Version[] }) | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [tags, setTags] = useState("");
  const [refs, setRefs] = useState<{ id: string; title: string; archived: boolean }[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Doc & { versions: Version[] }>("GET", `/v1/documents/${id}`).then(
      (r) => {
        setD(r);
        setTags(r.tags.join(" "));
      },
      (e: Error) => setErr(e.message),
    );
    api<{ items: { id: string; title: string; archived: boolean }[] }>("GET", `/v1/documents/${id}/conversations`).then((r) => setRefs(r.items), () => {});
  }, [id]);
  useEffect(load, [load]);
  useGlobalStream((ev) => ev === "job" && load());
  const cur = d?.versions.find((v) => v.current) ?? d?.versions[0];
  const purge = () => {
    const n = refs.filter((r) => !r.archived).length;
    const ok = window.confirm(
      `彻底删除后，原文、正文、片段和索引都会被清除，无法恢复。

以下副本无法随之删除：
` +
        `1. 对话记录：模型曾经看到过的片段会保留在相关会话里${n > 0 ? `（有 ${n} 个未归档的会话引用过这份资料，建议先归档）` : ""}；
` +
        `2. 备份：最多保留 7 天，恢复备份后会按删除记录重新删除；
` +
        `3. 模型服务商：已经发送给 DeepSeek 的内容受对方的数据政策约束。

确定彻底删除吗？`,
    );
    if (!ok) return;
    api("DELETE", `/v1/documents/${id}`).then(
      () => {
        location.hash = "#/docs";
      },
      (e: Error) => setErr(e.message),
    );
  };
  const archive = (convId: string) => api("PATCH", `/v1/conversations/${convId}`, { archived: true }).then(load, (e: Error) => setErr(e.message));
  const act = (what: "revoke" | "restore") => api("POST", `/v1/documents/${id}/${what}`).then(load, (e: Error) => setErr(e.message));
  return (
    <div className="page">
      <a href="#/docs">← 返回资料列表</a>
      {err && <div className="error">{err}</div>}
      {d && (
        <>
          <h2>{d.title}</h2>
          <div className="row">
            <span className={`pill ${d.status}`}>{STATUS[d.status] ?? d.status}</span>
            {d.source_uri && <span className="muted">{d.source_uri}</span>}
            {d.error_code && <span className="error">{d.error_code}</span>}
          </div>
          <div className="row">
            {d.status === "ready" && <button onClick={() => void act("revoke")}>停止使用</button>}
            {d.status === "revoked" && <button onClick={() => void act("restore")}>恢复使用</button>}
            {d.status !== "purging" && (
              <button className="danger" onClick={purge}>
                彻底删除
              </button>
            )}
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="标签" />
            <button
              onClick={() => {
                api("PATCH", `/v1/documents/${id}`, { tags: parseTags(tags) }).then(load, (e: Error) => setErr(e.message));
              }}
            >
              保存标签
            </button>
          </div>
          <h3>版本</h3>
          <ul className="list">
            {d.versions.map((v) => (
              <li key={v.id}>
                {fmtTime(v.captured_at)} · {v.char_count} 字 · {v.status}
                {v.current && <span className="tag">当前</span>}
                <button
                  className="right"
                  onClick={() => {
                    api<string>("GET", `/v1/documents/${id}/versions/${v.id}/text`).then(setText, (e: Error) => setErr(e.message));
                  }}
                >
                  查看正文
                </button>
              </li>
            ))}
          </ul>
          {cur && summary === null && (
            <div>
              <pre className="muted">{cur.summary ? `摘要：
${cur.summary}` : "摘要：生成中或暂无"}</pre>
              {cur.summary && <button onClick={() => setSummary(cur.summary)}>编辑摘要</button>}
            </div>
          )}
          {summary !== null && (
            <div>
              <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={6} />
              <div className="row">
                <button
                  onClick={() => {
                    api("PATCH", `/v1/documents/${id}`, { summary }).then(
                      () => {
                        setSummary(null);
                        load();
                      },
                      (e: Error) => setErr(e.message),
                    );
                  }}
                >
                  保存摘要
                </button>
                <button onClick={() => setSummary(null)}>取消</button>
              </div>
              <p className="muted">编辑后不会再被自动覆盖。</p>
            </div>
          )}
          {refs.length > 0 && (
            <>
              <h3>引用过这份资料的会话</h3>
              <ul className="list">
                {refs.map((r) => (
                  <li key={r.id}>
                    <a href={`#/chat/${r.id}`}>{r.title}</a>
                    {r.archived ? <span className="tag">已归档</span> : <button className="right" onClick={() => void archive(r.id)}>归档</button>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {text !== null && <pre className="doctext">{text}</pre>}
        </>
      )}
    </div>
  );
}
