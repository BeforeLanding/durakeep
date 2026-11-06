import { expect, test } from "vitest";
import { normalizeUrl, urlHash } from "./url.ts";

test("规范化：scheme / host 小写、去默认端口与 fragment、去追踪参数、其余参数按键排序", () => {
  expect(normalizeUrl("HTTPS://Example.COM:443/Post?b=2&a=1&utm_source=x&spm=a.b&from=wx#section")).toBe("https://example.com/Post?a=1&b=2");
  expect(normalizeUrl("http://example.com:80")).toBe("http://example.com/");
  expect(normalizeUrl("http://example.com:8080/p")).toBe("http://example.com:8080/p"); // 非默认端口保留
  expect(normalizeUrl("  https://example.com/a?z=1&z=0&a=9  ")).toBe("https://example.com/a?a=9&z=1&z=0"); // 同键保持原顺序
  expect(normalizeUrl("https://example.com/a?UTM_Medium=1&fbclid=2&gclid=3&keep=1")).toBe("https://example.com/a?keep=1");
});

test("等价写法得到同一个结果；IDN 转 punycode；路径大小写与编码保留", () => {
  const a = normalizeUrl("https://example.com/a?x=1&y=2");
  expect(normalizeUrl("https://EXAMPLE.com/a?y=2&x=1&utm_campaign=z#top")).toBe(a);
  expect(urlHash(a)).toMatch(/^[0-9a-f]{64}$/);
  expect(normalizeUrl("https://例子.中国/页面")).toBe("https://xn--fsqu00a.xn--fiqs8s/%E9%A1%B5%E9%9D%A2");
});

test("拒绝：非 http(s)、带用户名口令、无法解析", () => {
  for (const bad of ["ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.com/", "https://user@example.com/", "not a url", ""]) {
    expect(() => normalizeUrl(bad), bad).toThrowError(/URL|链接/);
  }
});
