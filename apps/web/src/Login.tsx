import { useState } from "react";
import { api, ApiError } from "./api.ts";

export function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="center">
      <form
        className="card login"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setErr("");
          api("POST", "/v1/auth/login", { password })
            .then(onDone)
            .catch((x: ApiError) => setErr(x.code === "locked" ? "尝试次数过多，请稍后再试" : x.message))
            .finally(() => setBusy(false));
        }}
      >
        <h2>durakeep</h2>
        <input type="password" autoFocus placeholder="口令" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="primary" disabled={busy || password === ""}>登录</button>
        {err && <div className="error">{err}</div>}
      </form>
    </div>
  );
}
