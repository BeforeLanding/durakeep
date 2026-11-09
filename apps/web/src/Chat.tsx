import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, uuid, type Citation, type Conversation as Conv, type Entry, type Live, type Snapshot } from "./api.ts";

const idCmp = (a: string, b: string) => (a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0);
/** 按条目 id 合并（重连后的快照只含错过的条目），保持升序。 */
const merge = (old: Entry[], incoming: Entry[]): Entry[] => {
  const m = new Map(old.map((e) => [e.id, e]));
  for (const e of incoming) m.set(e.id, e);
  return [...m.values()].sort((a, b) => idCmp(a.id, b.id));
};
/** 回答里的 <citations> 块只给机器读，不展示（流式时未写完的块也隐藏）。 */
const stripCitations = (t: string) => t.replace(/<citations>[\s\S]*$/, "").trimEnd();

const REASON: Record<string, string> = {
  revoked: "资料已停止使用",
  purged: "资料已删除",
  missing: "找不到这个片段",
  superseded: "资料已有新版本",
  not_in_run: "这次回答没有检索到这个片段",
  unresolved: "正文有标记但没有对应引用",
};

export function Chat({ convId }: { convId: string | undefined }) {
  const [convs, setConvs] = useState<Conv[]>([]);
  const loadConvs = useCallback(() => {
    api<{ items: Conv[] }>("GET", "/v1/conversations").then((r) => setConvs(r.items.filter((c) => !c.archived)));
  }, []);
  useEffect(loadConvs, [loadConvs, convId]);
  const create = () =>
    api<Conv>("POST", "/v1/conversations", {}).then((c) => {
      location.hash = `#/chat/${c.id}`;
    });
  return (
    <div className="chat">
      <aside className="side">
        <button className="primary wide" onClick={() => void create()}>新对话</button>
        {convs.map((c) => (
          <a key={c.id} href={`#/chat/${c.id}`} className={c.id === convId ? "on" : ""}>{c.title || "（未命名）"}</a>
        ))}
      </aside>
      <section className="conv">
        {convId ? <ConversationView key={convId} id={convId} onActivity={loadConvs} /> : <div className="muted pad">选择或新建一个对话。</div>}
      </section>
    </div>
  );
}

function ConversationView({ id, onActivity }: { id: string; onActivity: () => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [live, setLive] = useState<Live>({ running: false, tools: [], queued: 0 });
  const [hasEarlier, setHasEarlier] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const [connected, setConnected] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    // EventSource 断线后自动重连并带 Last-Event-ID；重连的快照只含错过的条目，所以按 id 合并
    const es = new EventSource(`/v1/conversations/${id}/stream`);
    let first = true;
    es.addEventListener("snapshot", (ev) => {
      const s = JSON.parse((ev as MessageEvent<string>).data) as Snapshot;
      setConnected(true);
      setEntries((old) => merge(old, s.entries));
      setLive(s.live);
      if (first) setHasEarlier(s.hasEarlier);
      first = false;
      if (!s.live.running) onActivity();
    });
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [id, onActivity]);

  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [entries, live.partialText]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setErr("");
    try {
      await api("POST", `/v1/conversations/${id}/messages`, { client_request_id: uuid(), text: t, steer: live.running });
      setText("");
      stick.current = true;
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "发送失败");
    }
  };
  const act = (what: "abort" | "continue") => api("POST", `/v1/conversations/${id}/${what}`).catch((e: Error) => setErr(e.message));
  const loadEarlier = async () => {
    const oldest = entries[0]?.id;
    const r = await api<{ entries: Entry[]; has_earlier: boolean }>("GET", `/v1/conversations/${id}/entries?limit=50${oldest ? `&before=${oldest}` : ""}`);
    setEntries((old) => merge(old, r.entries));
    setHasEarlier(r.has_earlier);
  };

  const failure = live.runFailure;
  const canContinue = failure && !live.running && ["model_error", "interrupted", "restart_limit", "turn_limit", "aborted"].includes(failure.reason);
  return (
    <>
      <div
        className="msgs"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {!connected && <div className="banner">连接中断，正在重连…</div>}
        {hasEarlier && <button onClick={() => void loadEarlier()}>加载更早的消息</button>}
        {entries.map((e) => <EntryView key={e.id} e={e} />)}
        {live.running && (
          <div className="msg assistant live">
            {live.partialText ? stripCitations(live.partialText) : <span className="muted">思考中…</span>}
          </div>
        )}
        {failure && !live.running && (
          <div className="banner error">
            {failure.message}
            {canContinue && <button onClick={() => void act("continue")}>继续</button>}
          </div>
        )}
        <div ref={endRef} />
      </div>
      {err && <div className="error pad">{err}</div>}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          rows={2}
          value={text}
          placeholder={live.running ? "回答生成中，可以插话…" : "问点什么（Enter 发送，Shift+Enter 换行）"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="col">
          <button className="primary" disabled={text.trim() === ""}>{live.running ? "插话" : "发送"}</button>
          {live.running && <button type="button" onClick={() => void act("abort")}>停止</button>}
          {live.queued > 0 && <span className="muted">排队 {live.queued}</span>}
        </div>
      </form>
    </>
  );
}

function EntryView({ e }: { e: Entry }) {
  switch (e.type) {
    case "user":
      return <div className="msg user">{e.text}</div>;
    case "assistant":
      // 只含工具调用的助手条目没有正文，不画空气泡
      if (stripCitations(e.text) === "" && !(e.citations?.length)) return null;
      return <div className="msg assistant"><Answer text={stripCitations(e.text)} citations={e.citations ?? []} /></div>;
    case "tool":
      return <div className={`tool ${e.ok ? "" : "bad"}`}>{e.ok ? "✓" : "✗"} {e.name}{e.summary ? ` · ${e.summary}` : ""}</div>;
    case "compaction":
      return <div className="tool">（较早的对话已压缩）</div>;
    case "event":
      return <div className="tool">事件：{e.kind}</div>;
  }
}

/** 把正文里的 [n] 换成可悬停的引用标记；渲染全部走 React 文本节点（不使用 innerHTML）。 */
function Answer({ text, citations }: { text: string; citations: Citation[] }) {
  const byN = new Map(citations.map((c) => [c.n, c]));
  const parts = text.split(/(\[\d+\])/);
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\[(\d+)\]$/.exec(p);
        const c = m ? byN.get(Number(m[1])) : undefined;
        return <Fragment key={i}>{c ? <Cite c={c} /> : p}</Fragment>;
      })}
      {citations.length > 0 && (
        <div className="refs">
          {citations.map((c) => (
            <div key={c.n}>
              <Cite c={c} />{" "}
              {c.valid ? (
                <a href={`#/docs/${c.document_id}`}>{c.title}{c.loc ? ` · ${c.loc}` : ""}</a>
              ) : (
                <span className="bad">{REASON[c.invalid_reason ?? ""] ?? "引用无效"}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const chunkCache = new Map<number, string>();
function Cite({ c }: { c: Citation }) {
  const [tip, setTip] = useState<string | null>(null);
  const show = () => {
    const chunkId = c.chunk_id;
    if (!c.valid || chunkId === null) return setTip(REASON[c.invalid_reason ?? ""] ?? "引用无效");
    const hit = chunkCache.get(chunkId);
    if (hit !== undefined) return setTip(hit);
    setTip("加载中…");
    api<{ text: string }>("GET", `/v1/chunks/${chunkId}`).then(
      (r) => {
        chunkCache.set(chunkId, r.text);
        setTip(r.text);
      },
      () => setTip("无法加载这个片段"),
    );
  };
  return (
    <span className={`cite ${c.valid ? "" : "bad"}`} onMouseEnter={show} onMouseLeave={() => setTip(null)} onFocus={show} onBlur={() => setTip(null)} tabIndex={0}>
      [{c.n}]
      {tip !== null && <span className="tip">{tip.length > 400 ? tip.slice(0, 400) + "…" : tip}</span>}
    </span>
  );
}
