import { expect, test } from "vitest";
import { charsetFromContentType, charsetFromMeta, decodeBody, detectCharset } from "./charset.ts";

const bytes = (...b: number[]) => new Uint8Array(b);
const enc = (s: string) => new TextEncoder().encode(s);
// "你好" 的 GBK / GB18030 字节
const GBK_NIHAO = [0xc4, 0xe3, 0xba, 0xc3];

test("优先级：BOM > HTTP 头 > meta > UTF-8", () => {
  expect(detectCharset(bytes(0xef, 0xbb, 0xbf, 0x41), "text/html; charset=gbk")).toBe("utf-8");
  expect(detectCharset(enc("<meta charset=gbk>"), "text/html; charset=utf-8")).toBe("utf-8"); // 头优先于 meta
  expect(detectCharset(enc('<html><meta charset="gb18030">'), "text/html")).toBe("gb18030");
  expect(detectCharset(enc("<html>无声明</html>"), undefined)).toBe("utf-8");
});

test("meta 的两种写法；未知字符集退回 UTF-8", () => {
  expect(charsetFromMeta(enc('<meta http-equiv="Content-Type" content="text/html; charset=GBK">'))).toBe("gbk");
  expect(charsetFromMeta(enc("<meta charset='big5'>"))).toBe("big5");
  expect(charsetFromContentType("text/html; charset=nonsense-9")).toBeUndefined();
  expect(detectCharset(enc("<meta charset=nonsense-9>"), "text/html; charset=also-bad")).toBe("utf-8");
});

test("GBK / GB18030 页面正确解码为中文", () => {
  const html = [...enc("<html><head><meta charset=gbk></head><body>"), ...GBK_NIHAO, ...enc("</body></html>")];
  const r = decodeBody(new Uint8Array(html), "text/html");
  expect(r.charset).toBe("gbk");
  expect(r.text).toContain("你好");
  expect(decodeBody(new Uint8Array(GBK_NIHAO), "text/plain; charset=GB18030").text).toBe("你好");
});

test("UTF-8 的坏字节不抛错，变成替换字符", () => {
  const r = decodeBody(bytes(0x68, 0x69, 0xff, 0x21), "text/plain");
  expect(r.text).toBe("hi�!");
});
