import { useCallback, useEffect, useState } from "react";
import { api, type Notification } from "./api.ts";
import { fmtTime, useGlobalStream } from "./hooks.ts";
import { Empty, PageHead } from "./ui.tsx";

export function Notifications({ onChange }: { onChange: () => void }) {
  const [items, setItems] = useState<Notification[]>([]);
  const load = useCallback(() => {
    api<{ items: Notification[] }>("GET", "/v1/notifications").then((r) => setItems(r.items));
  }, []);
  useEffect(load, [load]);
  useGlobalStream((ev) => (ev === "notification" || ev === "unread") && load());
  const done = () => {
    load();
    onChange();
  };
  return (
    <div className="page">
      <PageHead title="通知" desc="提醒到点、后台任务完成等消息。" />
      <div className="row">
        <button
          onClick={() => {
            api("POST", "/v1/notifications/read-all").then(done);
          }}
        >
          全部标为已读
        </button>
      </div>
      {items.length === 0 && <Empty icon="bell" title="没有通知" />}
      <ul className="list col-list">
        {items.map((n) => (
          <li key={n.id} className="mem" style={{ opacity: n.read ? 0.6 : 1 }}>
            <div className="row">
              <strong>{n.title}</strong>
              <span>{n.body}</span>
              {n.link === "/jobs" && <a href="#/jobs">查看任务</a>}
              <span className="muted right">{fmtTime(n.created_at)}</span>
              {!n.read && (
                <button
                  onClick={() => {
                    api("POST", `/v1/notifications/${n.id}/read`).then(done);
                  }}
                >
                  已读
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
