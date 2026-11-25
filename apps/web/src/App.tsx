import { useCallback, useEffect, useState } from "react";
import { api, setUnauthenticatedHandler, type Me } from "./api.ts";
import { Chat } from "./Chat.tsx";
import { Docs } from "./Docs.tsx";
import { Jobs } from "./Jobs.tsx";
import { Login } from "./Login.tsx";
import { Memories } from "./Memories.tsx";
import { Notifications } from "./Notifications.tsx";
import { Reminders } from "./Reminders.tsx";
import { Settings } from "./Settings.tsx";
import { useGlobalStream, useRoute } from "./hooks.ts";
import { Icon, initial, Logo, ToastProvider } from "./ui.tsx";

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = 检查中

  const refresh = useCallback(() => {
    api<Me>("GET", "/v1/me").then(setMe, () => setMe(null));
  }, []);
  useEffect(() => {
    setUnauthenticatedHandler(() => setMe(null));
    refresh();
  }, [refresh]);

  if (me === undefined) return <div className="center"><span className="spinner muted" /></div>;
  return (
    <ToastProvider>
      {me === null ? (
        <Login onDone={refresh} />
      ) : (
        <Shell me={me} onMe={setMe} onLogout={() => setMe(null)} />
      )}
    </ToastProvider>
  );
}

const NAV: [string, string, string][] = [
  ["chat", "对话", "chat"],
  ["docs", "资料", "book"],
  ["memories", "记忆", "brain"],
  ["reminders", "提醒", "alarm"],
];
const NAV2: [string, string, string][] = [
  ["jobs", "任务", "jobs"],
  ["settings", "设置", "settings"],
];

/** 登录之后才挂载：这里才会打开全局流（未读数、提醒到点）。 */
function Shell({ me, onMe, onLogout }: { me: Me; onMe: (me: Me) => void; onLogout: () => void }) {
  const route = useRoute();
  const [unread, setUnread] = useState(0);
  const [budgetWarning, setBudgetWarning] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
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
  useEffect(() => setMenu(false), [tab, route[1]]);

  const link = ([name, label, icon]: [string, string, string]) => (
    <a key={name} href={`#/${name}`} className={tab === name ? "on" : ""} aria-current={tab === name ? "page" : undefined}>
      <Icon name={icon} />
      {label}
    </a>
  );
  return (
    <div className="shell">
      <header className="topbar">
        <button className="ghost icon" aria-label="打开菜单" onClick={() => setMenu(true)}><Icon name="menu" /></button>
        <div className="brand" style={{ padding: 0 }}><Logo />durakeep</div>
      </header>
      {menu && <div className="scrim" onClick={() => setMenu(false)} />}
      <div className={`sidebar ${menu ? "open" : ""}`}>
        <a className="brand" href="#/chat"><Logo />durakeep</a>
        <nav className="nav" aria-label="主导航">
          {NAV.map(link)}
          <a href="#/notifications" className={tab === "notifications" ? "on" : ""}>
            <Icon name="bell" />
            通知{unread > 0 && <span className="badge">{unread}</span>}
          </a>
          <div className="sep" />
          {NAV2.map(link)}
        </nav>
        <div className="spacer" />
        <div className="me">
          <div className="avatar" aria-hidden="true">{initial(me.display_name)}</div>
          <div className="who">
            <b>{me.display_name}</b>
            <span>{me.timezone}</span>
          </div>
          <button
            className="ghost icon"
            title="退出登录"
            aria-label="退出"
            onClick={() => {
              api("POST", "/v1/auth/logout").finally(onLogout);
            }}
          >
            <Icon name="logout" />
          </button>
        </div>
      </div>
      <main className="main">
        {tab === "docs" ? (
          <Docs docId={route[1]} feishu={me.capabilities?.feishu_docs ?? false} />
        ) : tab === "jobs" ? (
          <Jobs timezone={me.timezone} />
        ) : tab === "settings" ? (
          <Settings me={me} onMe={onMe} timezone={me.timezone} onTimezone={(timezone) => onMe({ ...me, timezone })} />
        ) : tab === "memories" ? (
          <Memories />
        ) : tab === "reminders" ? (
          <Reminders timezone={me.timezone} />
        ) : tab === "notifications" ? (
          <Notifications onChange={refreshUnread} />
        ) : (
          <Chat convId={route[1]} budgetWarning={budgetWarning} me={me} />
        )}
      </main>
    </div>
  );
}
