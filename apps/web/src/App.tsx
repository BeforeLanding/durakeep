import { useCallback, useEffect, useState } from "react";
import { api, setUnauthenticatedHandler } from "./api.ts";
import { Chat } from "./Chat.tsx";
import { Docs } from "./Docs.tsx";
import { Jobs } from "./Jobs.tsx";
import { Login } from "./Login.tsx";
import { useRoute } from "./hooks.ts";

type Me = { owner_id: string; display_name: string; timezone: string };

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = 检查中
  const route = useRoute();

  const refresh = useCallback(() => {
    api<Me>("GET", "/v1/me").then(setMe, () => setMe(null));
  }, []);
  useEffect(() => {
    setUnauthenticatedHandler(() => setMe(null));
    refresh();
  }, [refresh]);

  if (me === undefined) return <div className="center muted">加载中…</div>;
  if (me === null) return <Login onDone={refresh} />;

  const tab = route[0] ?? "chat";
  return (
    <div className="shell">
      <nav className="nav">
        <strong>durakeep</strong>
        <a href="#/chat" className={tab === "chat" ? "on" : ""}>对话</a>
        <a href="#/docs" className={tab === "docs" ? "on" : ""}>资料</a>
        <a href="#/jobs" className={tab === "jobs" ? "on" : ""}>任务</a>
        <span className="grow" />
        <span className="muted">{me.display_name}</span>
        <button
          onClick={() => {
            api("POST", "/v1/auth/logout").finally(() => setMe(null));
          }}
        >
          退出
        </button>
      </nav>
      <main className="main">
        {tab === "docs" ? <Docs docId={route[1]} /> : tab === "jobs" ? <Jobs /> : <Chat convId={route[1]} />}
      </main>
    </div>
  );
}
