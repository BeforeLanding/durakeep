import { useCallback, useEffect, useState } from "react";
import { api, type Notification } from "./api.ts";
import { fmtTime, useGlobalStream } from "./hooks.ts";

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
      <h2>通知</h2>
      <div className="row">
        <button
          onClick={() => {
            api("POST", "/v1/notifications/read-all").then(done);
          }}
        >
          全部标为已读
        </button>
      </div>
      {items.length === 0 && <div className="muted">没有通知。</div>}
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
