import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";

export type Listening = { port: number; host: string; close(): Promise<void> };

/** 只监听给定地址（默认 loopback）。port 为 0 时由系统分配。 */
export function listen(fetch: (req: Request) => Response | Promise<Response>, opts: { host: string; port: number }): Promise<Listening> {
  return new Promise((resolve) => {
    const server = serve({ fetch, hostname: opts.host, port: opts.port }, (info: AddressInfo) =>
      resolve({
        port: info.port,
        host: info.address,
        close: () => new Promise<void>((r) => server.close(() => r())),
      }),
    );
  });
}
