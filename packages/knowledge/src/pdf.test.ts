import { expect, test } from "vitest";
import { AppError } from "@durakeep/core";
import { linesToMarkdown, pdfToMarkdown } from "./pdf.ts";
import { makePdf } from "./testing/pdf.ts";

test("中文 PDF（不嵌入字体、UniGB-UCS2-H 编码，需要 CMap）：抽出文字，按字号识别标题，去掉页码", async () => {
  const pdf = makePdf([
    [{ text: "学习计划", size: 22 }, { text: "复习方法", size: 16 }, { text: "每天复习三十分钟，" }, { text: "坚持一个月。" }, { text: "1" }],
    [{ text: "第二部分", size: 16 }, { text: "周末整理笔记。" }, { text: "2" }],
  ]);
  const r = await pdfToMarkdown(pdf);
  expect(r.pages).toBe(2);
  expect(r.title).toBe("学习计划");
  expect(r.markdown).toBe(["# 学习计划", "", "## 复习方法", "", "每天复习三十分钟，坚持一个月。", "", "## 第二部分", "", "周末整理笔记。", ""].join("\n"));
});

test("没有文字层 / 不是 PDF / 损坏：extract_failed，并给出可读的原因", async () => {
  const empty = makePdf([[]]);
  await expect(pdfToMarkdown(empty)).rejects.toThrow(/没有可提取的文字/);
  await expect(pdfToMarkdown(new TextEncoder().encode("hello"))).rejects.toThrow(/不是有效的 PDF/);
  const broken = await pdfToMarkdown(new TextEncoder().encode("%PDF-1.4 broken")).catch((e: AppError) => e);
  expect(broken).toBeInstanceOf(AppError);
  expect((broken as AppError).code).toBe("extract_failed");
});

test("行拼段：英文折行加空格、中文不加；列表项；每页重复的页眉被去掉", () => {
  const L = (text: string, page: number, size = 10) => ({ text, size, page });
  const md = linesToMarkdown([
    L("公司内部资料", 1), L("This is a long", 1), L("English sentence.", 1), L("• 第一项", 1),
    L("公司内部资料", 2), L("第 2 页", 2), L("中文段落第一行", 2), L("第二行。", 2),
    L("公司内部资料", 3), L("2 / 3", 3), L("结尾。", 3),
  ], 3);
  expect(md).toBe(["This is a long English sentence.", "", "- 第一项", "", "中文段落第一行第二行。", "", "结尾。", ""].join("\n"));
});
