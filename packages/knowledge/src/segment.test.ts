import { expect, test } from "vitest";
import { buildMatchQuery, segment, segmentForIndex, STOPWORDS, substringQuery } from "./segment.ts";

test("中文按词切分；停用词被去掉；标点不产生词", () => {
  const t = segment("间隔重复是一种根据遗忘曲线安排复习时间的学习方法。");
  expect(t).toContain("遗忘");
  expect(t).toContain("复习");
  expect(t).toContain("学习");
  expect(t).not.toContain("的");
  expect(t).not.toContain("是");
  expect(t.every((w) => !/[。，、]/.test(w))).toBe(true);
});

test("两个字的词也能切出来（FR-KB-04：两字词也能搜到）", () => {
  expect(segment("记忆")).toEqual(["记忆"]);
  expect(segment("复习")).toEqual(["复习"]);
  expect(segment("猫")).toEqual(["猫"]);
});

test("NFKC + 小写：全角字母数字与大小写归一；英文按词切分", () => {
  expect(segment("ＳＱＬｉｔｅ　３")).toEqual(["sqlite", "3"]);
  expect(segment("Node.js and SQLite")).toContain("sqlite");
  expect(segment("The Quick Brown Fox")).toEqual(["quick", "brown", "fox"]); // the 是停用词
});

test("否定词不是停用词：不支持 与 支持 的差别不会被吃掉", () => {
  for (const neg of ["不", "没有", "无", "非", "不是"]) expect(STOPWORDS.has(neg), neg).toBe(false);
  expect(segment("不支持中文")).toContain("不");
  expect(STOPWORDS.size).toBeGreaterThanOrEqual(50);
  expect(STOPWORDS.size).toBeLessThanOrEqual(90);
});

test("入库与查询共用同一个函数：同一句话两边切出的词一致", () => {
  const s = "遗忘曲线描述了记忆随时间衰减的规律";
  expect(segmentForIndex(s).split(" ")).toEqual(segment(s));
  expect(segment("  遗忘曲线\n")).toEqual(segment("遗忘曲线"));
});

test("全是停用词或标点：没有词，MATCH 表达式为 undefined（调用方提示“请换个说法”）", () => {
  expect(segment("的 了 是 ！？")).toEqual([]);
  expect(buildMatchQuery([])).toBeUndefined();
});

test("MATCH 表达式：词加引号、OR 连接、去重、双引号加倍转义、至多 32 个词", () => {
  expect(buildMatchQuery(["遗忘", "复习"])).toBe('"遗忘" OR "复习"');
  expect(buildMatchQuery(["a", "a", "b"])).toBe('"a" OR "b"');
  expect(buildMatchQuery(['say"hi'])).toBe('"say""hi"');
  const many = Array.from({ length: 50 }, (_, i) => `w${i}`);
  expect(buildMatchQuery(many)!.split(" OR ")).toHaveLength(32);
  // FTS5 的运算符字符放进引号里就只是普通文本
  expect(buildMatchQuery(["near", "and*", "x:y", "-z"])).toBe('"near" OR "and*" OR "x:y" OR "-z"');
});

test("子串路：只取连续 ≥3 个字符的片段，最多 3 个且最长优先；没有则不执行", () => {
  expect(substringQuery("忘曲线")).toBe('"忘曲线"');
  expect(substringQuery("复习")).toBeUndefined(); // 两个字符：不走子串路
  expect(substringQuery("a b")).toBeUndefined();
  // 同样长（6 个字符）的片段保持查询里出现的先后顺序；“复习”只有 2 个字符被丢弃；FTS5 只有 4 个字符，排在最后
  expect(substringQuery("间隔重复 SQLite 复习 FTS5 全文检索功能")).toBe('"SQLite" OR "全文检索功能" OR "间隔重复"');
  expect(substringQuery("你好，世界！")).toBeUndefined(); // 被标点切成两段，各 2 个字符
  expect(substringQuery('说"你好吗"')).toBe('"你好吗"');
});
