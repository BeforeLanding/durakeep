
import { expect, test } from "vitest";
import { feishuFromEnv, feishuSignature, parseWebhookUrl } from "./feishu.ts";

test("飞书域名、HTTPS 和机器人路径同时匹配才允许请求，测试开关只允许回环 HTTP", () => {
  const path = "/open-apis/bot/v2/hook/mock-token";
  for (const host of ["open.feishu.cn", "open.larksuite.com"]) {
    expect(parseWebhookUrl("https://" + host + path)?.hostname).toBe(host);
  }
  for (const url of [
    "http://open.feishu.cn" + path, "https://open.feishu.cn.attacker.invalid" + path,
    "https://open.feishu.cn@attacker.invalid" + path, "https://user@open.feishu.cn" + path,
    "https://open.feishu.cn:8443" + path, "https://open.feishu.cn/unrelated",
    "https://open.feishu.cn" + path + "?extra=1", "https://open.feishu.cn" + path + "/extra",
  ]) expect(parseWebhookUrl(url)).toBeUndefined();
  const mock = "http://127.0.0.1:4321" + path;
  expect(parseWebhookUrl(mock)).toBeUndefined();
  expect(parseWebhookUrl(mock, true)?.port).toBe("4321");
  expect(parseWebhookUrl("https://open.feishu.cn" + path, true)).toBeUndefined();
});

test("飞书签名以带换行的时间戳和 secret 为 HMAC 密钥，对空字符串签名", () => {
  expect(feishuSignature(1599360473999, "test-secret")).toEqual({
    timestamp: "1599360473",
    sign: "wSds2BzzFIIGf/WrhUO+NI1q/9j+FRJd3JNHKAq0NZY=",
  });
});

test("测试和演示不使用部署环境中的飞书凭据", () => {
  const env = { FEISHU_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/fixture" };
  expect(feishuFromEnv("demo", env)).toBeUndefined();
  expect(feishuFromEnv("test", env)).toBeUndefined();
  expect(feishuFromEnv("test", { ...env, FEISHU_ALLOW_LOOPBACK: "1" })).toBeUndefined();
  expect(feishuFromEnv("prod", env)).toBeDefined();
});
