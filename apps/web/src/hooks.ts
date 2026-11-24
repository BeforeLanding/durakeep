import { useEffect, useState } from "react";

/** 哈希路由：#/chat/:id、#/docs、#/docs/:id、#/jobs */
export function useRoute(): string[] {
  const parse = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [r, setR] = useState(parse);
  useEffect(() => {
    const f = () => setR(parse());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return r;
}

/** 全局流（job 事件等）：有事件时调用 onEvent。 */
export function useGlobalStream(onEvent: (event: string, data: unknown) => void) {
  useEffect(() => {
    const es = new EventSource("/v1/stream");
    const handler = (name: string) => (e: MessageEvent<string>) => onEvent(name, JSON.parse(e.data));
    for (const n of ["job", "notification", "runtime", "unread", "budget"]) es.addEventListener(n, handler(n) as EventListener);
    return () => es.close();
  }, []);
}

export const fmtTime = (ms: number) => new Date(ms).toLocaleString("zh-CN", { hour12: false });
