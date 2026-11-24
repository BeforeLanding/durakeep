import { useCallback, useEffect, useState } from "react";
import { api, setUnauthenticatedHandler } from "./api.ts";
import { Chat } from "./Chat.tsx";
import { Docs } from "./Docs.tsx";
import { Jobs } from "./Jobs.tsx";
import { Login } from "./Login.tsx";
import { Memories } from "./Memories.tsx";
import { Notifications } from "./Notifications.tsx";
import { Reminders } from "./Reminders.tsx";
import { useGlobalStream, useRoute } from "./hooks.ts";

type Me = { owner_id: string; display_name: string; timezone: string };

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = 检查中

  const refresh = useCallback(() => {
    api<Me>("GET", "/v1/me").then(setMe, () => setMe(null));
  }, []);
  useEffect(() => {
    setUnauthenticatedHandler(() => setMe(null));
    refresh();
  }, [refresh]);

  if (me === undefined) return <div className="center muted">加载中…</div>;
  if (me === null) return <Login onDone={refresh} />;
  return <Shell me={me} onLogout={() => setMe(null)} />;
}

/** 登录之后才挂载：这里才会打开全局流（未读数、提醒到点）。 */
function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const route = useRoute();
  const [unread, setUnread] = useState(0);
  const [budgetWarning, setBudgetWarning] = useState<string | null>(null);
  const refreshUnread = useCallback(() => {
    api<{ unread: number }>("GET", "/v1/notifications?unread=1").then((r) => setUnread(r.unread), () => {});
  }, []);
  useEffect(refreshUnread, [refreshUnread]);
  useGlobalStream((ev, data) => {
    if (ev === "unread") setUnread((data as { count: number }).count);
    else if (ev === "budget") setBudgetWarning((data as { budget_warning: string | null }).budget_warning);
    else if (ev === "notification") refreshUnread();
  });

  const tab = route[0] ?? "chat";
  const link = (name: string, label: string) => (
    <a href={`#/${name}`} className={tab === name ? "on" : ""}>
      {label}
    </a>
  );
  return (
    <div className="shell">
      <nav className="nav">
        <strong>durakeep</strong>
        {link("chat", "对话")}
        {link("docs", "资料")}
        {link("memories", "记忆")}
        {link("reminders", "提醒")}
        {link("jobs", "任务")}
        <span className="grow" />
        <a href="#/notifications" className={tab === "notifications" ? "on" : ""}>
          通知{unread > 0 && <span className="badge">{unread}</span>}
        </a>
        <span className="muted">{me.display_name}</span>
        <button
          onClick={() => {
            api("POST", "/v1/auth/logout").finally(onLogout);
          }}
        >
          退出
        </button>
      </nav>
      <main className="main">
        {tab === "docs" ? (
          <Docs docId={route[1]} />
        ) : tab === "jobs" ? (
          <Jobs />
        ) : tab === "memories" ? (
          <Memories />
        ) : tab === "reminders" ? (
          <Reminders timezone={me.timezone} />
        ) : tab === "notifications" ? (
          <Notifications onChange={refreshUnread} />
        ) : (
          <Chat convId={route[1]} budgetWarning={budgetWarning} />
        )}
      </main>
    </div>
  );
}
