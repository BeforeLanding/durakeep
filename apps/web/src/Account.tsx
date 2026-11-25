import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Me, type Session } from "./api.ts";
import { StrengthMeter } from "./Login.tsx";
import { ago, Icon, initial, useToast } from "./ui.tsx";

/** 设置页顶部：个人资料、改口令、登录设备管理。 */
export function Account({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  return (
    <>
      <Profile me={me} onMe={onMe} />
      <Password />
      <Sessions />
    </>
  );
}

function Profile({ me, onMe }: { me: Me; onMe: (me: Me) => void }) {
  const [name, setName] = useState(me.display_name);
  const toast = useToast();
  return (
    <section className="ops-section">
      <h3>个人资料</h3>
      <form
        className="row"
        style={{ gap: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          api<Me>("PATCH", "/v1/me", { display_name: name }).then(
            (r) => { onMe({ ...me, display_name: r.display_name }); toast("已更新称呼"); },
            (x: Error) => toast(x.message, false),
          );
        }}
      >
        <div className="avatar" style={{ width: 44, height: 44, fontSize: 18 }} aria-hidden="true">{initial(name || me.display_name)}</div>
        <label className="field grow" style={{ minWidth: 200 }}>
          <span className="label">称呼</span>
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <button disabled={name.trim() === "" || name.trim() === me.display_name} style={{ alignSelf: "flex-end" }}>保存</button>
      </form>
    </section>
  );
}

function Password() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const toast = useToast();
  const mismatch = confirm !== "" && confirm !== next;
  return (
    <section className="ops-section">
      <h3>修改口令</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setErr("");
          api("POST", "/v1/auth/password", { current_password: current, new_password: next })
            .then(() => {
              setCurrent("");
              setNext("");
              setConfirm("");
              toast("口令已修改，其他设备已退出登录");
            })
            .catch((x: ApiError) => setErr(x.message))
            .finally(() => setBusy(false));
        }}
      >
        <div className="ops-fields">
          <label>当前口令<input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
          <label>新口令<input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /><StrengthMeter value={next} /></label>
          <label>确认新口令<input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />{mismatch && <span className="small error">两次输入不一致</span>}</label>
        </div>
        <div className="row" style={{ marginBottom: 0 }}>
          <button className="primary" disabled={busy || !current || next.length < 8 || next !== confirm}>修改口令</button>
          <span className="muted small">修改后，除当前设备外的所有登录都会失效。</span>
        </div>
        {err && <div className="notice bad" role="alert" style={{ marginTop: 10 }}><Icon name="alert" />{err}</div>}
      </form>
    </section>
  );
}

function Sessions() {
  const [items, setItems] = useState<Session[] | null>(null);
  const toast = useToast();
  const load = useCallback(() => {
    api<{ items: Session[] }>("GET", "/v1/auth/sessions").then((r) => setItems(r.items), () => setItems([]));
  }, []);
  useEffect(load, [load]);
  const fail = (e: Error) => toast(e.message, false);
  const others = (items ?? []).filter((s) => !s.current).length;
  return (
    <section className="ops-section">
      <div className="row" style={{ margin: "0 0 8px", justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>登录设备</h3>
        {others > 0 && (
          <button className="sm danger" onClick={() => {
            if (window.confirm(`退出其他 ${others} 个设备上的登录？`)) api("POST", "/v1/auth/sessions/revoke-others").then(() => { toast("已退出其他设备"); load(); }, fail);
          }}>退出其他设备</button>
        )}
      </div>
      {items === null ? <p className="muted">正在读取…</p> : (
        <ul className="sessions">
          {items.map((s) => (
            <li key={s.id}>
              <div className="dev"><Icon name="device" /></div>
              <div className="grow">
                <div><b>{s.device}</b>{s.current && <span className="pill ready" style={{ marginLeft: 8 }}>当前设备</span>}</div>
                <div className="muted small">
                  最近活跃 {ago(s.last_seen_at)} · 登录于 {new Date(s.created_at).toLocaleDateString("zh-CN")} · {s.persistent ? "保持登录" : "关闭浏览器即失效"}
                </div>
              </div>
              {!s.current && <button className="sm" onClick={() => api("DELETE", `/v1/auth/sessions/${s.id}`).then(() => { toast("已退出该设备"); load(); }, fail)}>退出</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
