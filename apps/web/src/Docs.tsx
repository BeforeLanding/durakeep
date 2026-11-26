import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, uuid, type Doc, type Job, type Version } from "./api.ts";
import { fmtTime, useGlobalStream } from "./hooks.ts";
import { ago, Empty, Icon, PageHead, useToast } from "./ui.tsx";

const STATUS: Record<string, string> = { pending: "处理中", ready: "可用", revoked: "已停用", failed: "失败", purging: "删除中" };

/** 错误码 → 用户看得懂、知道下一步怎么做的说明（作业的具体错误信息优先）。 */
const ERROR_HINT: Record<string, string> = {
  login_required: "这个页面需要登录才能查看，无法直接抓取。可以复制正文粘贴，或导出文件后上传。",
  permission_denied: "没有读取权限。飞书文档需要把你的应用添加为文档协作者。",
  robots_disallowed: "该网站不允许程序抓取这个页面。可以复制正文粘贴进来。",
  unsupported_type: "不支持的内容类型（例如图片、视频或压缩包链接）。",
  too_large: "内容太大，超过了大小上限。",
  ssrf_blocked: "出于安全考虑，不允许访问内网或本机地址。",
  fetch_failed: "无法访问这个网址，请检查链接是否能在浏览器中打开。",
  fetch_timeout: "访问超时，可以稍后重试。",
  extract_failed: "页面里没有找到可以提取的正文。",
  not_found: "原文不存在或已被删除。",
};

const parseTags = (s: string) => [...new Set(s.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean))];
const ACCEPT = ".pdf,.docx,.md,.markdown,.txt,.html,.htm";

const isFeishu = (u: string) => /^https?:\/\/[^/]*(feishu\.cn|feishu\.net|larkoffice\.com|larksuite\.com)\//i.test(u.trim());
const LOGIN_WALL: [RegExp, string][] = [
  [/^https?:\/\/docs\.qq\.com\//i, "腾讯文档"],
  [/^https?:\/\/(www\.)?notion\.(so|site)\//i, "Notion"],
  [/^https?:\/\/[^/]*shimo\.im\//i, "石墨文档"],
  [/^https?:\/\/[^/]*dingtalk\.com\//i, "钉钉文档"],
];

const hostOf = (u: string | null) => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
};
const FORMAT_LABEL: Record<string, string> = { pdf: "PDF", docx: "Word", html: "HTML" };
const sourceLabel = (d: Doc) => {
  if (d.source_type === "url") {
    const where = isFeishu(d.source_uri ?? "") ? "飞书文档" : hostOf(d.source_uri) || "网页";
    return d.source_format === "pdf" ? `${where} · PDF` : where;
  }
  if (d.source_format) return FORMAT_LABEL[d.source_format] ?? d.source_format;
  return d.source_type === "markdown" ? "Markdown" : "文本";
};
const sourceIcon = (d: Doc) => (d.source_type === "url" ? "globe" : d.source_type === "markdown" || d.source_format ? "file" : "text");
/** 图标底色：飞书蓝、网页青、PDF 红、Word 蓝，其余用主题色。 */
const icoClass = (d: Doc) =>
  d.source_type === "url" ? (isFeishu(d.source_uri ?? "") ? "feishu" : d.source_format === "pdf" ? "pdf" : "url") : (d.source_format ?? "");
const PAGE = 50;

export function Docs({ docId, feishu }: { docId: string | undefined; feishu: boolean }) {
  return docId ? <Detail id={docId} /> : <List feishu={feishu} />;
}

function useFailedJobs(dep: unknown) {
  const [byDoc, setByDoc] = useState<Map<string, Job>>(new Map());
  useEffect(() => {
    api<{ items: Job[] }>("GET", "/v1/jobs?status=failed&limit=100").then(
      (r) => setByDoc(new Map(r.items.filter((j) => j.document_id).map((j) => [j.document_id!, j]))),
      () => {},
    );
  }, [dep]);
  return byDoc;
}

function List({ feishu }: { feishu: boolean }) {
  const [items, setItems] = useState<Doc[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");
  const [tick, setTick] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [want, setWant] = useState(PAGE); // 想显示的条数；“加载更多”每次加一页
  const [more, setMore] = useState(false);
  /** 从头取够 want 条（作业事件刷新时也保持已展开的条数，不会跳回第一页）。 */
  const load = useCallback(async () => {
    const base = new URLSearchParams();
    if (q) base.set("q", q);
    if (status) base.set("status", status);
    try {
      const all: Doc[] = [];
      let next: string | null = null;
      do {
        const qs = new URLSearchParams(base);
        qs.set("limit", String(Math.min(100, Math.max(PAGE, want - all.length))));
        if (next) qs.set("cursor", next);
        const r: { items: Doc[]; next_cursor: string | null } = await api("GET", `/v1/documents?${qs}`);
        all.push(...r.items);
        next = r.next_cursor;
      } while (next && all.length < want);
      setItems(all);
      setCursor(next);
      setLoaded(true);
      setTick((t) => t + 1);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setMore(false);
    }
  }, [q, status, want]);
  useEffect(() => void load(), [load]);
  useEffect(() => setWant(PAGE), [q, status]);
  useGlobalStream((ev) => ev === "job" && void load());
  const failed = useFailedJobs(tick);
  const filtering = q !== "" || status !== "";
  const hits = useFullText(q);
  return (
    <div className="page">
      <PageHead title="资料" desc="收藏的网页、文档和笔记都会被切分索引，对话时自动检索并标注出处。" />
      <Capture onDone={() => void load()} feishu={feishu} />
      <div className="toolbar">
        <div className="search">
          <Icon name="search" />
          <input placeholder="搜索标题和正文" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索资料" />
        </div>
        <div className="seg" style={{ margin: 0 }}>
          {[["", "全部"], ["ready", "可用"], ["pending", "处理中"], ["failed", "失败"], ["revoked", "已停用"]].map(([k, v]) => (
            <button key={k} className={status === k ? "on" : ""} onClick={() => setStatus(k!)}>{v}</button>
          ))}
        </div>
      </div>
      {err && <div className="notice bad"><Icon name="alert" />{err}</div>}
      {hits && hits.length > 0 && (
        <section className="hits">
          <div className="section-label">正文中的匹配 · {hits.length}</div>
          {hits.map((h) => (
            <a key={h.chunk_id} className="hit" href={`#/docs/${h.document_id}`}>
              <div className="hit-title"><Icon name="file" />{h.title}{h.loc && <span className="muted small"> · {h.loc}</span>}</div>
              <div className="hit-snippet"><Highlight text={h.snippet} query={q} /></div>
            </a>
          ))}
          {items.length > 0 && <div className="section-label" style={{ marginTop: 14 }}>标题匹配 · {items.length}</div>}
        </section>
      )}
      {loaded && items.length === 0 && !(hits && hits.length > 0) && (
        filtering ? <Empty icon="search" title="没有符合条件的资料" /> : (
          <Empty icon="book" title="知识库还是空的">
            <div>贴一个链接、上传一份 Word，或者在对话里说“收藏：……”。</div>
          </Empty>
        )
      )}
      <ul className="doc-list">
        {items.map((d) => {
          const job = failed.get(d.id);
          return (
            <li key={d.id}>
              <div className={`doc-ico ${icoClass(d)}`}><Icon name={sourceIcon(d)} /></div>
              <div className="doc-main">
                <a href={`#/docs/${d.id}`}>{d.title}</a>
                <div className="doc-meta">
                  <span>{sourceLabel(d)}</span>
                  <span>·</span>
                  <span title={fmtTime(d.created_at)}>{ago(d.created_at)}</span>
                  {d.tags.map((t) => <span key={t} className="tag">{t}</span>)}
                </div>
                {d.status === "failed" && (
                  <div className="doc-err">{job?.error_message ?? ERROR_HINT[d.error_code ?? ""] ?? d.error_code ?? "处理失败"}</div>
                )}
              </div>
              <span className={`pill ${d.status}`}>{STATUS[d.status] ?? d.status}</span>
            </li>
          );
        })}
      </ul>
      {cursor && (
        <div className="row" style={{ justifyContent: "center", marginTop: 14 }}>
          <button disabled={more} onClick={() => { setMore(true); setWant(items.length + PAGE); }}>
            {more ? <span className="spinner" /> : null}加载更多
          </button>
        </div>
      )}
    </div>
  );
}

type Hit = { chunk_id: number; document_id: string; title: string; source_type: string; loc: string; snippet: string };

/** 输入 ≥2 个字符后（防抖 250 ms）调用全文搜索；与对话里的检索是同一条链路。 */
function useFullText(q: string): Hit[] | null {
  const [hits, setHits] = useState<Hit[] | null>(null);
  useEffect(() => {
    const t = q.trim();
    if (Array.from(t).length < 2) {
      setHits(null);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      api<{ items: Hit[] }>("GET", `/v1/search?q=${encodeURIComponent(t)}&top_k=8`).then((r) => live && setHits(r.items), () => live && setHits(null));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [q]);
  return hits;
}

/** 高亮查询词（整句与按空白 / 标点拆开的词）；只生成文本节点与 <mark>。 */
function Highlight({ text, query }: { text: string; query: string }) {
  const terms = [...new Set([query.trim(), ...query.split(/[\s,，。、？?！!]+/)])].filter((t) => t.length > 0).sort((a, b) => b.length - a.length);
  if (terms.length === 0) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return <>{text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part))}</>;
}

function Capture({ onDone, feishu }: { onDone: () => void; feishu: boolean }) {
  const [mode, setMode] = useState<"url" | "text" | "file">("url");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const [tags, setTags] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const hint = useMemo(() => {
    const u = url.trim();
    if (!u) return null;
    if (isFeishu(u)) {
      return feishu
        ? { kind: "ok", text: "飞书文档将通过开放平台导入。请确认已在文档「…」→「添加文档应用」里添加了你的应用。" }
        : { kind: "warn", text: "飞书文档需要登录才能读取，直接抓取只会拿到登录页。服务端配置 FEISHU_APP_ID / FEISHU_APP_SECRET 后即可直接导入；也可以在飞书里「导出为 Word」后切到「上传文件」。" };
    }
    const wall = LOGIN_WALL.find(([re]) => re.test(u));
    if (wall) return { kind: "warn", text: `${wall[1]}需要登录才能查看，无法直接抓取。请导出为 Word / Markdown 后上传，或复制正文粘贴。` };
    return null;
  }, [url, feishu]);

  const submitOne = async (body: Record<string, unknown> | FormData) => api<{ deduplicated: boolean }>("POST", "/v1/documents", body);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const tagList = parseTags(tags);
    try {
      if (mode === "file") {
        let ok = 0;
        const errors: string[] = [];
        for (const file of files) {
          const f = new FormData();
          f.set("file", file);
          f.set("client_request_id", uuid());
          f.set("tags", JSON.stringify(tagList));
          try {
            await submitOne(f);
            ok++;
          } catch (e) {
            errors.push(`${file.name}：${e instanceof ApiError ? e.message : "上传失败"}`);
          }
        }
        if (ok > 0) toast(`已收藏 ${ok} 个文件，正在建立索引`);
        if (errors.length > 0) setErr(errors.join("\n"));
        setFiles(errors.length > 0 ? files.filter((f) => errors.some((e) => e.startsWith(f.name + "："))) : []);
      } else {
        const r = mode === "url"
          ? await submitOne({ client_request_id: uuid(), type: "url", url: url.trim(), tags: tagList })
          : await submitOne({ client_request_id: uuid(), type: "text", ...(title.trim() ? { title: title.trim() } : {}), text, tags: tagList });
        toast(r.deduplicated ? "这份资料已经收藏过了" : "已收藏，正在抓取并建立索引");
        setUrl("");
        setTitle("");
        setText("");
      }
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "提交失败");
    } finally {
      setBusy(false);
    }
  };
  const ready = mode === "url" ? url.trim() !== "" : mode === "text" ? text.trim() !== "" : files.length > 0;
  const pick = (list: FileList | null) => {
    if (!list) return;
    setErr(null);
    setFiles((old) => [...old, ...Array.from(list)].slice(0, 20));
  };
  const tabs: ["url" | "text" | "file", string, string][] = [["url", "网页链接", "link"], ["text", "粘贴文本", "text"], ["file", "上传文件", "upload"]];
  return (
    <div className="card capture">
      <div className="capture-tabs">
        {tabs.map(([m, label, icon]) => (
          <button key={m} className={mode === m ? "on" : ""} onClick={() => { setMode(m); setErr(null); }}>
            <Icon name={icon} />
            {label}
          </button>
        ))}
      </div>
      <div className="capture-body">
        {mode === "url" && (
          <>
            <div className="url-input">
              <input
                className="wide"
                placeholder="粘贴网页或飞书文档链接：https://…"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setErr(null); }}
                onKeyDown={(e) => { if (e.key === "Enter" && ready && !busy) void submit(); }}
              />
            </div>
            {hint && !err && <div className={`notice ${hint.kind === "warn" ? "warn" : ""}`}><Icon name={hint.kind === "warn" ? "info" : "check"} /><span>{hint.text}</span></div>}
          </>
        )}
        {mode === "text" && (
          <>
            <input className="wide" placeholder="标题（可选）" value={title} onChange={(e) => setTitle(e.target.value)} />
            <textarea className="wide" rows={6} placeholder="正文（≤50 万字符）" value={text} onChange={(e) => setText(e.target.value)} />
          </>
        )}
        {mode === "file" && (
          <div
            className={`drop ${over ? "over" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileRef.current?.click(); }}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files); }}
          >
            <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { pick(e.target.files); e.target.value = ""; }} />
            {files.length === 0 ? (
              <>
                <Icon name="upload" />
                <b>拖拽文件到这里，或点击选择</b>
                <div className="small">支持 PDF（≤20 MB，需有文字层）、Word（.docx，≤10 MB）、Markdown、TXT、HTML（≤2 MB）· 飞书 / 腾讯文档可先导出为 Word 或 PDF</div>
              </>
            ) : (
              <div className="stack" style={{ alignItems: "center" }}>
                {files.map((f, i) => (
                  <span key={i} className="file">
                    <Icon name="file" />{f.name}<span className="muted small">{(f.size / 1024).toFixed(0)} KB</span>
                    <button className="ghost icon sm" aria-label={`移除 ${f.name}`} onClick={(e) => { e.stopPropagation(); setFiles(files.filter((_, j) => j !== i)); }}><Icon name="x" /></button>
                  </span>
                ))}
                <span className="small">点击继续添加</span>
              </div>
            )}
          </div>
        )}
        <div className="capture-foot">
          <input placeholder="标签（逗号或空格分隔，≤10 个）" value={tags} onChange={(e) => setTags(e.target.value)} />
          <button className="primary" disabled={busy || !ready} onClick={() => void submit()}>
            {busy ? <span className="spinner" /> : <Icon name="plus" />}收藏
          </button>
        </div>
        {err && <div className="notice bad" role="alert" style={{ whiteSpace: "pre-wrap" }}><Icon name="alert" /><span>{err}</span></div>}
      </div>
    </div>
  );
}

function Detail({ id }: { id: string }) {
  const [d, setD] = useState<(Doc & { versions: Version[] }) | null>(null);
  const [text, setText] = useState<{ vid: string; body: string } | null>(null);
  const [err, setErr] = useState("");
  const [tags, setTags] = useState("");
  const [refs, setRefs] = useState<{ id: string; title: string; archived: boolean }[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [job, setJob] = useState<Job | undefined>();
  const toast = useToast();
  const load = useCallback(() => {
    api<Doc & { versions: Version[] }>("GET", `/v1/documents/${id}`).then(
      (r) => {
        setD(r);
        setTags(r.tags.join(" "));
        if (r.status === "failed") {
          api<{ items: Job[] }>("GET", "/v1/jobs?status=failed&limit=100").then((j) => setJob(j.items.find((x) => x.document_id === id)), () => {});
        } else setJob(undefined);
      },
      (e: Error) => setErr(e.message),
    );
    api<{ items: { id: string; title: string; archived: boolean }[] }>("GET", `/v1/documents/${id}/conversations`).then((r) => setRefs(r.items), () => {});
  }, [id]);
  useEffect(load, [load]);
  useGlobalStream((ev) => ev === "job" && load());
  const cur = d?.versions.find((v) => v.current) ?? d?.versions[0];
  const fail = (e: Error) => toast(e.message, false);
  const purge = () => {
    const n = refs.filter((r) => !r.archived).length;
    const ok = window.confirm(
      `彻底删除后，原文、正文、片段和索引都会被清除，无法恢复。\n\n以下副本无法随之删除：\n` +
        `1. 对话记录：模型曾经看到过的片段会保留在相关会话里${n > 0 ? `（有 ${n} 个未归档的会话引用过这份资料，建议先归档）` : ""}；\n` +
        `2. 备份：最多保留 7 天，恢复备份后会按删除记录重新删除；\n` +
        `3. 模型服务商：已经发送给 DeepSeek 的内容受对方的数据政策约束。\n\n确定彻底删除吗？`,
    );
    if (!ok) return;
    api("DELETE", `/v1/documents/${id}`).then(() => {
      toast("已开始删除");
      location.hash = "#/docs";
    }, fail);
  };
  const archive = (convId: string) => api("PATCH", `/v1/conversations/${convId}`, { archived: true }).then(load, fail);
  const act = (what: "revoke" | "restore") => api("POST", `/v1/documents/${id}/${what}`).then(() => { toast(what === "revoke" ? "已停止使用：对话中不会再检索到它" : "已恢复使用"); load(); }, fail);
  const retry = () => job && api("POST", `/v1/jobs/${job.id}/retry`).then(() => { toast("已重新排队"); load(); }, fail);
  const refresh = () => api<{ created: boolean }>("POST", `/v1/documents/${id}/refresh`).then((r) => {
    toast(r.created ? "正在重新抓取：内容有变化时会生成新版本" : "已经在抓取中了");
    load();
  }, fail);
  const showText = (vid: string) => {
    if (text?.vid === vid) return setText(null);
    api<string>("GET", `/v1/documents/${id}/versions/${vid}/text`).then((body) => setText({ vid, body }), fail);
  };
  return (
    <div className="page">
      <a className="back" href="#/docs"><Icon name="back" />资料</a>
      {err && <div className="notice bad"><Icon name="alert" />{err}</div>}
      {d && (
        <>
          <div className="doc-head">
            <div className={`doc-ico ${icoClass(d)}`}><Icon name={sourceIcon(d)} /></div>
            <div className="grow" style={{ minWidth: 0 }}>
              <h2>{d.title}</h2>
              <div className="doc-meta">
                <span className={`pill ${d.status}`}>{STATUS[d.status] ?? d.status}</span>
                <span>{sourceLabel(d)}</span>
                <span>·</span>
                <span>收藏于 {fmtTime(d.created_at)}</span>
              </div>
            </div>
          </div>

          {d.status === "failed" && (
            <div className="notice bad" style={{ marginTop: 16 }}>
              <Icon name="alert" />
              <div className="grow">
                <b>处理失败</b>
                <div>{job?.error_message ?? ERROR_HINT[d.error_code ?? ""] ?? d.error_code}</div>
                {job?.error_message && ERROR_HINT[d.error_code ?? ""] && <div className="muted small" style={{ marginTop: 4 }}>{ERROR_HINT[d.error_code ?? ""]}</div>}
              </div>
              {job && <button className="sm" onClick={() => void retry()}><Icon name="refresh" />重试</button>}
            </div>
          )}

          <div className="card">
            <dl className="kv">
              {d.source_uri && (<><dt>来源</dt><dd><a href={d.source_uri} target="_blank" rel="noopener noreferrer">{d.source_uri}</a></dd></>)}
              <dt>标签</dt>
              <dd>
                <div className="row" style={{ margin: 0 }}>
                  <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="标签" style={{ flex: 1, minWidth: 160 }} />
                  <button className="sm" onClick={() => api("PATCH", `/v1/documents/${id}`, { tags: parseTags(tags) }).then(() => { toast("标签已保存"); load(); }, fail)}>保存标签</button>
                </div>
              </dd>
              {cur && (<><dt>正文</dt><dd>{cur.char_count.toLocaleString()} 字 · 共 {d.versions.length} 个版本</dd></>)}
            </dl>
            <div className="row" style={{ marginBottom: 0 }}>
              {d.source_type === "url" && (d.status === "ready" || d.status === "failed") && (
                <button onClick={() => void refresh()} title="重新读取原网页或飞书文档；内容有变化时生成新版本，旧版本保留">
                  <Icon name="refresh" />重新抓取
                </button>
              )}
              {d.status === "ready" && <button onClick={() => void act("revoke")}>停止使用</button>}
              {d.status === "revoked" && <button onClick={() => void act("restore")}>恢复使用</button>}
              <span className="grow" />
              {d.status !== "purging" && <button className="danger" onClick={purge}><Icon name="trash" />彻底删除</button>}
            </div>
          </div>

          {cur && (
            <div className="card">
              <div className="row" style={{ margin: 0, justifyContent: "space-between" }}>
                <h3 style={{ margin: 0, display: "flex", gap: 8, alignItems: "center" }}><Icon name="spark" />摘要</h3>
                {summary === null && cur.summary && <button className="ghost sm" onClick={() => setSummary(cur.summary)}>编辑摘要</button>}
              </div>
              {summary === null ? (
                <div className={cur.summary ? "summary" : "muted"}>{cur.summary ? cur.summary : "摘要生成中或暂无"}</div>
              ) : (
                <>
                  <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={6} />
                  <div className="row" style={{ margin: 0 }}>
                    <button className="primary sm" onClick={() => api("PATCH", `/v1/documents/${id}`, { summary }).then(() => { setSummary(null); toast("摘要已保存"); load(); }, fail)}>保存摘要</button>
                    <button className="sm" onClick={() => setSummary(null)}>取消</button>
                    <span className="muted small">编辑后不会再被自动覆盖。</span>
                  </div>
                </>
              )}
            </div>
          )}

          <h3>版本</h3>
          <ul className="list">
            {d.versions.map((v) => (
              <li key={v.id} style={{ flexWrap: "wrap" }}>
                <span>{fmtTime(v.captured_at)}</span>
                <span className="muted">{v.char_count.toLocaleString()} 字</span>
                <span className={`pill ${v.status}`}>{v.status}</span>
                {v.current && <span className="tag">当前</span>}
                <button className="right sm" onClick={() => showText(v.id)}>{text?.vid === v.id ? "收起正文" : "查看正文"}</button>
                {text?.vid === v.id && <pre className="doctext" style={{ width: "100%", margin: "8px 0 0" }}>{text.body}</pre>}
              </li>
            ))}
          </ul>

          {refs.length > 0 && (
            <>
              <h3>引用过这份资料的会话</h3>
              <ul className="list">
                {refs.map((r) => (
                  <li key={r.id}>
                    <Icon name="chat" />
                    <a href={`#/chat/${r.id}`}>{r.title}</a>
                    {r.archived ? <span className="tag right">已归档</span> : <button className="right sm" onClick={() => void archive(r.id)}>归档</button>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
