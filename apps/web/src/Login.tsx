import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "./api.ts";
import { Icon, Logo } from "./ui.tsx";

type Status = { initialized: boolean; setup_pending: boolean };

/** 未登录时的入口：已初始化 → 登录；还没有账号 → 首次设置。 */
export function Login({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    api<Status>("GET", "/v1/auth/status").then(setStatus, () => setStatus({ initialized: true, setup_pending: false }));
  }, []);
  return (
    <div className="auth">
      <Hero />
      <div className="auth-panel">
        {status === null ? <span className="spinner muted" /> : status.initialized ? <SignIn onDone={onDone} /> : <Setup onDone={onDone} />}
      </div>
    </div>
  );
}

function Hero() {
  const items: [string, string, string][] = [
    ["book", "收藏即可检索", "网页、飞书文档、Word、笔记，丢进来就能被问到"],
    ["spark", "回答带出处", "每个结论都标注来自哪份资料，悬停即可核对原文"],
    ["brain", "记得你的习惯", "偏好与背景长期记住，可随时查看、修改、停用"],
    ["alarm", "说一句就提醒", "“明晚八点提醒我复习”，到点推送到浏览器或飞书"],
  ];
  return (
    <section className="auth-hero">
      <div className="brand"><Logo />durakeep</div>
      <h1>你的第二大脑，<br />安静地记住一切。</h1>
      <p>一个只属于你的知识与日常助理：资料、记忆和提醒都保存在你自己的电脑上。</p>
      <div className="features">
        {items.map(([icon, title, desc]) => (
          <div className="feature" key={title}>
            <div className="fi"><Icon name={icon} /></div>
            <div><b>{title}</b><span>{desc}</span></div>
          </div>
        ))}
      </div>
      <footer>数据只存本机 · 只监听 127.0.0.1 · 开源</footer>
    </section>
  );
}

function PasswordInput(props: { id: string; value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean; autoComplete: string; onCaps?: (on: boolean) => void }) {
  const [show, setShow] = useState(false);
  return (
    <div className="input-wrap">
      <input
        id={props.id}
        type={show ? "text" : "password"}
        autoFocus={props.autoFocus}
        autoComplete={props.autoComplete}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyUp={(e) => props.onCaps?.(e.getModifierState("CapsLock"))}
      />
      <button type="button" tabIndex={-1} aria-label={show ? "隐藏口令" : "显示口令"} onClick={() => setShow((s) => !s)}>
        <Icon name={show ? "eyeOff" : "eye"} />
      </button>
    </div>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function useCountdown(): [number, (ms: number) => void] {
  const [until, setUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (until <= now) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [until, now]);
  return [Math.max(0, Math.ceil((until - now) / 1000)), (ms) => { setNow(Date.now()); setUntil(Date.now() + ms); }];
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [caps, setCaps] = useState(false);
  const [wait, lock] = useCountdown();
  const hour = new Date().getHours();
  const greet = hour < 5 ? "夜深了" : hour < 11 ? "早上好" : hour < 14 ? "中午好" : hour < 18 ? "下午好" : "晚上好";
  return (
    <form
      className="auth-card"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setErr("");
        api("POST", "/v1/auth/login", { password, remember })
          .then(onDone)
          .catch((x: ApiError) => {
            setPassword("");
            if (x.code === "locked" || x.code === "rate_limited") {
              lock(Number(x.details.retry_after_ms ?? 60_000));
              setErr("尝试次数过多，已暂时锁定");
            } else {
              const left = x.details.attempts_left;
              setErr(typeof left === "number" && left <= 2 ? `口令不正确，再错 ${left} 次将锁定 1 分钟` : x.message);
            }
          })
          .finally(() => setBusy(false));
      }}
    >
      <div>
        <h2>{greet}，欢迎回来</h2>
        <p className="sub">输入口令解锁你的知识库</p>
      </div>
      <Field label="口令" htmlFor="pw">
        <PasswordInput id="pw" autoFocus autoComplete="current-password" placeholder="口令" value={password} onChange={setPassword} onCaps={setCaps} />
      </Field>
      {caps && <div className="notice warn"><Icon name="alert" />大写锁定已打开</div>}
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        在这台电脑上保持登录（14 天，使用时自动续期）
      </label>
      <button className="primary lg" disabled={busy || password === "" || wait > 0}>
        {busy ? <span className="spinner" /> : <Icon name="lock" />}
        {wait > 0 ? `请 ${wait} 秒后再试` : "登录"}
      </button>
      {err && <div className="notice bad" role="alert"><Icon name="alert" />{err}</div>}
      <p className="muted small" style={{ margin: 0 }}>
        忘记口令？在服务所在的电脑上运行 <code>pnpm cli passwd</code> 重设。
      </p>
    </form>
  );
}

/** 口令强度 0–4：长度、字符种类、是否只是重复或顺序串。 */
export function strength(p: string): number {
  if (p.length < 8) return p.length === 0 ? 0 : 1;
  if (/^(.)\1+$/.test(p) || "01234567890123456789abcdefghijklmnopqrstuvwxyz".includes(p.toLowerCase())) return 1;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^\da-zA-Z]/].filter((r) => r.test(p)).length + (/[^ -~]/.test(p) ? 1 : 0);
  let s = p.length >= 12 ? 2 : 1;
  if (kinds >= 2) s++;
  if (kinds >= 3 || p.length >= 16) s++;
  return Math.min(s, 4);
}
export const STRENGTH = ["", "太弱", "一般", "不错", "很强"];

export function StrengthMeter({ value }: { value: string }) {
  const s = strength(value);
  if (!value) return null;
  return (
    <div className="row" style={{ margin: 0, gap: 10 }}>
      <div className={`strength s${s}`} style={{ flex: 1 }}><i /><i /><i /><i /></div>
      <span className="small muted">{STRENGTH[s]}</span>
    </div>
  );
}

function Setup({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  const mismatch = confirm !== "" && confirm !== password;
  const ready = code.replace(/[^a-z0-9]/gi, "").length === 8 && password.length >= 8 && confirm === password;

  // 设置完成后服务会重启进入正常模式：轮询直到 /v1/me 可用
  const waitForServer = async () => {
    setStarting(true);
    for (let i = 0; i < 120; i++) {
      try {
        await api("GET", "/v1/me");
        return onDone();
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    setStarting(false);
    setErr("服务启动超时，请刷新页面");
  };

  if (starting) {
    return (
      <div className="auth-card" style={{ alignItems: "center", textAlign: "center" }}>
        <span className="spinner" style={{ width: 28, height: 28, color: "var(--acc)" }} />
        <h2>设置完成</h2>
        <p className="sub">正在启动你的助理…</p>
      </div>
    );
  }
  return (
    <form
      className="auth-card"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setErr("");
        api("POST", "/v1/auth/setup", { setup_code: code, display_name: name.trim() || undefined, password, timezone: tz })
          .then(waitForServer)
          .catch((x: ApiError) => setErr(x.message))
          .finally(() => setBusy(false));
      }}
    >
      <div className="steps"><i className="on" /><i className="on" /><i /></div>
      <div>
        <h2>创建你的助理</h2>
        <p className="sub">只需一次。之后用这个口令登录。</p>
      </div>
      <Field label="设置码" htmlFor="code" hint="启动服务的终端里打印了一个 8 位设置码，用来确认是你本人在操作。">
        <input id="code" className="code-input" autoFocus autoComplete="one-time-code" placeholder="XXXX-XXXX" maxLength={9} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
      </Field>
      <Field label="怎么称呼你" htmlFor="name">
        <input id="name" placeholder="例如：小明（可选）" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="登录口令" htmlFor="pw1" hint="至少 8 位；推荐用一句好记的话，比复杂的短口令更安全。">
        <PasswordInput id="pw1" autoComplete="new-password" placeholder="设置口令" value={password} onChange={setPassword} />
        <StrengthMeter value={password} />
      </Field>
      <Field label="再输一次" htmlFor="pw2">
        <PasswordInput id="pw2" autoComplete="new-password" placeholder="确认口令" value={confirm} onChange={setConfirm} />
        {mismatch && <div className="small error">两次输入不一致</div>}
      </Field>
      <div className="muted small">时区：{tz}（可在设置中修改）</div>
      <button className="primary lg" disabled={busy || !ready}>{busy ? <span className="spinner" /> : <Icon name="check" />}完成设置</button>
      {err && <div className="notice bad" role="alert"><Icon name="alert" />{err}</div>}
    </form>
  );
}
