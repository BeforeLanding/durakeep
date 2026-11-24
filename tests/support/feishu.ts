
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export const MOCK_SECRET = "feishu-fixture-signing-secret";
export const MOCK_TOKEN = "feishu-fixture-hook-token";

export async function mockFeishu(reply: (res: ServerResponse, count: number) => void) {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8").on("data", (chunk: string) => { body += chunk; });
    req.on("end", () => {
      try { requests.push(JSON.parse(body)); } catch { requests.push(null); }
      reply(res, requests.length);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/open-apis/bot/v2/hook/" + MOCK_TOKEN;
  return {
    url, requests,
    async close() {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
