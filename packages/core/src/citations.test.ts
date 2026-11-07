import { expect, test } from "vitest";
import { parseAnswer, stripCitationsForDisplay } from "./citations.ts";

test("标准格式：块被去掉，引用与正文标记分别解析", () => {
  const r = parseAnswer("间隔重复建议逐步拉长间隔 [1]，并且要在即将遗忘时复习 [2]。\n<citations>\n[1] chunk:1234\n[2] chunk:5678\n</citations>");
  expect(r.text).toBe("间隔重复建议逐步拉长间隔 [1]，并且要在即将遗忘时复习 [2]。");
  expect(r.citations).toEqual([
    { n: 1, chunkId: 1234, inRun: false },
    { n: 2, chunkId: 5678, inRun: false },
  ]);
  expect(r.markers).toEqual([1, 2]);
});

test("没有引用块：原样返回；没有标记也没有引用", () => {
  const r = parseAnswer("现有资料不足，缺少关于复习间隔的具体数值。");
  expect(r).toEqual({ text: "现有资料不足，缺少关于复习间隔的具体数值。", citations: [], markers: [] });
});

test("格式宽容：空白、大小写、CRLF；多个块以最后一个为准；块没有闭合标签时解析到末尾", () => {
  expect(parseAnswer("答 [1]\r\n<CITATIONS>\r\n  [1]   chunk:7  \r\n</CITATIONS>").citations).toEqual([{ n: 1, chunkId: 7, inRun: false }]);
  const two = parseAnswer("答 [1]\n<citations>\n[1] chunk:1\n</citations>\n补充 [2]\n<citations>\n[2] chunk:2\n</citations>");
  expect(two.citations).toEqual([{ n: 2, chunkId: 2, inRun: false }]);
  expect(two.text).not.toContain("<citations>");
  expect(parseAnswer("答 [1]\n<citations>\n[1] chunk:9").citations).toEqual([{ n: 1, chunkId: 9, inRun: false }]);
});

test("同一个编号重复：以第一次为准；有编号但格式不对的行 → chunkId 为 null（校验时判为无法解析）；其他行被忽略", () => {
  const r = parseAnswer("答 [1][2][3]\n<citations>\n[1] chunk:10\n[1] chunk:11\n[2] 第三章第二节\n[3] chunk:abc\n随便写的一行\n- chunk:5\n</citations>");
  expect(r.citations).toEqual([
    { n: 1, chunkId: 10, inRun: false },
    { n: 2, chunkId: null, inRun: false },
    { n: 3, chunkId: null, inRun: false },
  ]);
});

test("正文标记：排除数组下标、Markdown 链接、字母数字后紧跟的方括号；去重升序", () => {
  const r = parseAnswer("见 [3] 和 [1]，再见 [3]。代码 arr[2] 与 x[0][1]，链接 [4](http://a.b)，还有 [12] 和 [1234]。");
  expect(r.markers).toEqual([1, 3, 12]); // [1234] 超过 3 位不算
});

test("引用块里的 [n] 不算正文标记", () => {
  expect(parseAnswer("答。\n<citations>\n[1] chunk:1\n</citations>").markers).toEqual([]);
});

test("流式部分文本：去掉未写完的块与标签前缀；正常文本不动", () => {
  expect(stripCitationsForDisplay("回答 [1]。\n<citations>\n[1] chu")).toBe("回答 [1]。");
  expect(stripCitationsForDisplay("回答 [1]。\n<cit")).toBe("回答 [1]。\n");
  expect(stripCitationsForDisplay("回答 [1]。\n<")).toBe("回答 [1]。\n");
  expect(stripCitationsForDisplay("a < b 且 c > d")).toBe("a < b 且 c > d");
  expect(stripCitationsForDisplay("")).toBe("");
});
