import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, ApiError, uuid, type Citation, type Conversation as Conv, type Entry, type Live, type Me, type Snapshot } from "./api.ts";
import { Markdown } from "./md.tsx";
import { Icon, Logo, useToast } from "./ui.tsx";

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

const TOOL_LABEL: Record<string, string> = {
  kb_search: "检索资料",
  kb_get_source: "阅读原文",
  kb_list_documents: "浏览资料",
  kb_capture_text: "收藏文本",
  kb_capture_url: "收藏网页",
  memory_remember: "记住",
  memory_search: "回忆",
  reminder_create: "创建提醒",
  reminder_list: "查看提醒",
  reminder_update: "修改提醒",
  reminder_cancel: "取消提醒",
};

const SUGGESTIONS: [string, string, string, string][] = [
  ["book", "问我的资料", "间隔重复应该如何安排复习？", "回答会标注出自哪份资料"],
  ["spark", "随手收藏", "收藏：每周五整理本周的学习笔记。", "一句话存进知识库"],
  ["brain", "让它记住你", "记住我喜欢简短总结", "以后的回答都会照做"],
  ["alarm", "设个提醒", "明天晚上八点提醒我复习间隔重复", "到点通知你"],
];

function groupOf(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (d >= today) return "今天";
  if (d.getTime() >= today.getTime() - 86_400_000) return "昨天";
  if (d.getTime() >= today.getTime() - 7 * 86_400_000) return "最近 7 天";
  return "更早";
}

export function Chat({ convId, budgetWarning, me }: { convId: string | undefined; budgetWarning: string | null; me: Me }) {
  const [convs, setConvs] = useState<Conv[]>([]);
  const toast = useToast();
  const loadConvs = useCallback(() => {
    api<{ items: Conv[] }>("GET", "/v1/conversations").then((r) => setConvs(r.items.filter((c) => !c.archived)), () => {});
  }, []);
  useEffect(loadConvs, [loadConvs, convId]);
  const create = () =>
    api<Conv>("POST", "/v1/conversations", {}).then((c) => {
      location.hash = `#/chat/${c.id}`;
      return c;
    });
  /** 欢迎页直接提问：先建对话，再发第一条消息。 */
  const startWith = async (text: string) => {
    try {
      const c = await api<Conv>("POST", "/v1/conversations", {});
      await api("POST", `/v1/conversations/${c.id}/messages`, { client_request_id: uuid(), text, steer: false });
      location.hash = `#/chat/${c.id}`;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "发送失败", false);
    }
  };
  let lastGroup = "";
  return (
    <div className="chat">
      <aside className="side">
        <button className="primary wide" onClick={() => void create()}>
          <Icon name="plus" />
          新对话
        </button>
        {convs.length > 0 ? <div style={{ height: 6 }} /> : <p className="muted small" style={{ padding: "8px 10px" }}>还没有对话。从右边的建议开始，或直接提问。</p>}
        {convs.map((c) => {
          const g = groupOf(c.last_active_at);
          const head = g !== lastGroup ? <div className="group">{g}</div> : null;
          lastGroup = g;
          return (
            <div key={c.id} style={{ display: "contents" }}>
              {head}
              <a href={`#/chat/${c.id}`} className={c.id === convId ? "on" : ""} title={c.title || "（未命名）"}>
                <span>{c.title || "（未命名）"}</span>
              </a>
            </div>
          );
        })}
      </aside>
      <section className="conv">
        {convId ? (
          <ConversationView key={convId} id={convId} onActivity={loadConvs} budgetWarning={budgetWarning} />
        ) : (
          <Welcome name={me.display_name} onSend={startWith} budgetWarning={budgetWarning} />
        )}
      </section>
    </div>
  );
}

function Welcome({ name, onSend, budgetWarning }: { name: string; onSend: (text: string) => Promise<void>; budgetWarning: string | null }) {
  const [stats, setStats] = useState<{ docs: string; memories: number; reminders: number } | null>(null);
  useEffect(() => {
    Promise.all([
      api<{ items: unknown[]; next_cursor: string | null }>("GET", "/v1/documents?limit=100&status=ready"),
      api<{ items: unknown[] }>("GET", "/v1/memories?status=confirmed"),
      api<{ items: unknown[] }>("GET", "/v1/reminders?status=active"),
    ]).then(
      ([d, m, r]) => setStats({ docs: d.next_cursor ? "100+" : String(d.items.length), memories: m.items.length, reminders: r.items.length }),
      () => {},
    );
  }, []);
  const hour = new Date().getHours();
  const greet = hour < 5 ? "夜深了" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  return (
    <>
      <div className="msgs">
        <div className="welcome">
          <Logo />
          <h1>{name && name !== "我" ? `${greet}，${name}` : greet}</h1>
          <p>问问你收藏过的资料，或者让我帮你记点什么。</p>
          {stats && (
            <div className="stats">
              <a className="stat" href="#/docs"><Icon name="book" /><b>{stats.docs}</b> 份资料</a>
              <a className="stat" href="#/memories"><Icon name="brain" /><b>{stats.memories}</b> 条记忆</a>
              <a className="stat" href="#/reminders"><Icon name="alarm" /><b>{stats.reminders}</b> 个待办提醒</a>
            </div>
          )}
          <div className="suggest">
            {SUGGESTIONS.map(([icon, title, prompt, desc]) => (
              <button key={title} onClick={() => void onSend(prompt)}>
                <b><Icon name={icon} />{title}</b>
                <span>“{prompt}”</span>
                <span className="small">{desc}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <Composer draftKey="new" running={false} queued={0} budgetWarning={budgetWarning} onSend={onSend} />
    </>
  );
}

const draftStore = {
  key: (k: string) => `durakeep:draft:${k}`,
  get(k: string): string {
    try {
      return localStorage.getItem(this.key(k)) ?? "";
    } catch {
      return "";
    }
  },
  set(k: string, v: string) {
    try {
      if (v.trim() === "") localStorage.removeItem(this.key(k));
      else localStorage.setItem(this.key(k), v);
    } catch {
      /* 存储不可用时不保存草稿 */
    }
  },
};

/** 输入框：每个对话单独保存未发送的草稿（只存在本机浏览器），切换对话或刷新不丢。 */
function Composer({ draftKey, running, queued, budgetWarning, onSend, onAbort }: {
  draftKey: string;
  running: boolean;
  queued: number;
  budgetWarning: string | null;
  onSend: (text: string) => Promise<void>;
  onAbort?: () => void;
}) {
  const [text, setTextState] = useState(() => draftStore.get(draftKey));
  const setText = (v: string) => {
    setTextState(v);
    draftStore.set(draftKey, v);
  };
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
    el.style.overflowY = el.scrollHeight > 200 ? "auto" : "hidden";
  }, [text]);
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      await onSend(t);
      setText("");
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  };
  return (
    <div className="composer-wrap">
      {budgetWarning ? <div className="notice warn" role="status" style={{ marginBottom: 8 }}><Icon name="alert" />{budgetWarning}</div> : null}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={ref}
          rows={1}
          autoFocus
          value={text}
          placeholder={running ? "回答生成中，可以插话补充…" : "问点什么，或者说“收藏：…”“记住…”“提醒我…”"}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {running && onAbort && (
          <button type="button" className="ghost send" aria-label="停止" title="停止生成" onClick={onAbort}>
            <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" /></svg>
          </button>
        )}
        <button className="primary send" aria-label={running ? "插话" : "发送"} title={running ? "插话" : "发送"} disabled={text.trim() === "" || busy}>
          {busy ? <span className="spinner" /> : <Icon name="send" />}
        </button>
      </form>
      <div className="composer-foot">
        <span>Enter 发送 · Shift+Enter 换行</span>
        {queued > 0 && <span>排队 {queued} 条</span>}
      </div>
    </div>
  );
}

function ConversationView({ id, onActivity, budgetWarning }: { id: string; onActivity: () => void; budgetWarning: string | null }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [live, setLive] = useState<Live>({ running: false, tools: [], queued: 0 });
  const [hasEarlier, setHasEarlier] = useState(false);
  const [connected, setConnected] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const toast = useToast();

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
  }, [entries, live.partialText, live.running]);

  const send = async (t: string) => {
    try {
      await api("POST", `/v1/conversations/${id}/messages`, { client_request_id: uuid(), text: t, steer: live.running });
      stick.current = true;
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "发送失败", false);
      throw e;
    }
  };
  const act = (what: "abort" | "continue") => api("POST", `/v1/conversations/${id}/${what}`).catch((e: Error) => toast(e.message, false));
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
        {!connected && <div className="notice warn"><Icon name="refresh" />连接中断，正在重连…</div>}
        {hasEarlier && <button className="ghost sm" style={{ alignSelf: "center" }} onClick={() => void loadEarlier()}>加载更早的消息</button>}
        {entries.length === 0 && !live.running && <div className="muted" style={{ margin: "auto", textAlign: "center" }}>新的对话。问点什么吧。</div>}
        {entries.map((e) => <EntryView key={e.id} e={e} />)}
        {live.running && (
          <div className="turn bot">
            <div className="who"><BotMark /></div>
            <div className="msg assistant live">
              {live.partialText ? <Markdown text={stripCitations(live.partialText)} /> : <span className="typing" aria-label="思考中"><i /><i /><i /></span>}
            </div>
          </div>
        )}
        {failure && !live.running && (
          <div className="notice bad" role="alert">
            <Icon name="alert" />
            <span className="grow">{failure.message}</span>
            {canContinue && <button className="sm" onClick={() => void act("continue")}>继续</button>}
          </div>
        )}
        <div ref={endRef} />
      </div>
      <Composer draftKey={id} running={live.running} queued={live.queued} budgetWarning={budgetWarning} onSend={send} onAbort={() => void act("abort")} />
    </>
  );
}

function BotMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 4h9a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4V4Z" />
      <path d="M9 9h5M9 13h3" />
    </svg>
  );
}

function EntryView({ e }: { e: Entry }) {
  switch (e.type) {
    case "user":
      return <div className="msg user">{e.text}</div>;
    case "assistant":
      // 只含工具调用的助手条目没有正文，不画空气泡
      if (stripCitations(e.text) === "" && !(e.citations?.length)) return null;
      return (
        <div className="turn bot">
          <div className="who"><BotMark /></div>
          <div className="msg assistant"><Answer text={stripCitations(e.text)} citations={e.citations ?? []} /></div>
        </div>
      );
    case "tool":
      return (
        <div className={`tool ${e.ok ? "" : "bad"}`}>
          <Icon name={e.ok ? "check" : "x"} />
          {TOOL_LABEL[e.name] ?? e.name}
          {e.summary ? ` · ${e.summary}` : ""}
        </div>
      );
    case "compaction":
      return <div className="tool">较早的对话已压缩</div>;
    case "event":
      return <div className="tool">事件：{e.kind}</div>;
  }
}

/** 正文按 Markdown 渲染，[n] 换成可悬停的引用标记；渲染全部走 React 节点（不使用 innerHTML）。 */
function Answer({ text, citations }: { text: string; citations: Citation[] }) {
  const byN = new Map(citations.map((c) => [c.n, c]));
  return (
    <>
      <Markdown
        text={text}
        token={(tok) => {
          const c = byN.get(Number(tok.slice(1, -1)));
          return c ? <Cite c={c} /> : tok;
        }}
      />
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

