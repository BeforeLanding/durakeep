
import { createHmac } from "node:crypto";
import type { AppMode } from "@durakeep/core";

const PATH = /^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/;
const HOSTS = new Set(["open.feishu.cn", "open.larksuite.com"]);
const NOT_SENT = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

export type ReminderDelivery = { title: string; localTime: string; timezone: string; lateMinutes: number };
export type DeliveryResult =
  | { status: "succeeded" }
  | { status: "retry" | "failed" | "unknown"; code: string };

export function parseWebhookUrl(value: string, testLoopback = false): URL | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash || !PATH.test(url.pathname)) return undefined;
  if (testLoopback) return url.protocol === "http:" && url.hostname === "127.0.0.1" ? url : undefined;
  return url.protocol === "https:" && HOSTS.has(url.hostname) && !url.port ? url : undefined;
}

export function feishuSignature(now: number, secret: string) {
  const timestamp = String(Math.floor(now / 1000));
  return { timestamp, sign: createHmac("sha256", timestamp + "\n" + secret).update("").digest("base64") };
}

export class FeishuWebhookSender {
  readonly #url: URL;
  readonly #secret: string | undefined;
  readonly #timeoutMs: number;

  constructor(url: string, secret?: string, options: { testLoopback?: boolean; timeoutMs?: number } = {}) {
    const valid = parseWebhookUrl(url, options.testLoopback);
    if (!valid) throw new Error("invalid_feishu_webhook");
    this.#url = valid;
    this.#secret = secret;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(payload: ReminderDelivery, now: number): Promise<DeliveryResult> {
    const late = payload.lateMinutes > 0 ? "\n迟到 " + payload.lateMinutes + " 分钟" : "";
    const text = "提醒：" + payload.title + "\n" + payload.localTime + " " + payload.timezone + late;
    let response: Response;
    try {
      response = await fetch(this.#url, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.#timeoutMs),
        body: JSON.stringify({
          msg_type: "text",
          content: { text },
          ...(this.#secret ? feishuSignature(now, this.#secret) : {}),
        }),
      });
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code ?? "";
      return NOT_SENT.has(code) ? { status: "retry", code: "connection_unavailable" } : { status: "unknown", code: "response_unknown" };
    }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 429 || response.status === 503) return { status: "retry", code: response.status === 429 ? "rate_limited" : "service_unavailable" };
      if (response.status >= 400 && response.status < 500) return { status: "failed", code: "http_rejected" };
      return { status: "unknown", code: "response_unknown" };
    }
    try {
      const data: unknown = await response.json();
      const envelope = data as { code?: unknown; StatusCode?: unknown } | null;
      const code = envelope?.code ?? envelope?.StatusCode;
      if (typeof code !== "number") return { status: "unknown", code: "response_unknown" };
      if (code === 0) return { status: "succeeded" };
      return { status: "failed", code: code === 19021 ? "signature_rejected" : "webhook_rejected" };
    } catch {
      return { status: "unknown", code: "response_unknown" };
    }
  }
}

export function feishuFromEnv(mode: AppMode, env: NodeJS.ProcessEnv, invalid: () => void = () => {}): FeishuWebhookSender | undefined {
  const testLoopback = mode === "test" && env.FEISHU_ALLOW_LOOPBACK === "1";
  if (mode === "demo" || (mode === "test" && !testLoopback) || !env.FEISHU_WEBHOOK_URL) return undefined;
  try {
    return new FeishuWebhookSender(env.FEISHU_WEBHOOK_URL, env.FEISHU_WEBHOOK_SECRET, { testLoopback });
  } catch {
    invalid();
    return undefined;
  }
}
