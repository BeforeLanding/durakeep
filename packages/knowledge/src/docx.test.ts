import { expect, test } from "vitest";
import { AppError } from "@durakeep/core";
import { docxToMarkdown, readZipEntry } from "./docx.ts";
import { makeZip } from "./testing/zip.ts";

const p = (text: string, style?: string, list = false) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${list ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>` : ""}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const DOCUMENT = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
${p("学习计划", "1")}
${p("每天复习 &amp; 总结 &lt;30 分钟&gt;")}
${p("第一项", undefined, true)}
${p("第二项", undefined, true)}
${p("细节", "Heading2")}
<w:tbl><w:tr><w:tc>${p("科目")}</w:tc><w:tc>${p("时长")}</w:tc></w:tr><w:tr><w:tc>${p("英语")}</w:tc><w:tc>${p("20")}</w:tc></w:tr></w:tbl>
<w:p/>
</w:body></w:document>`;
const STYLES = `<w:styles><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style></w:styles>`;

test("docx → Markdown：中文样式 id 的标题、实体、列表、表格", () => {
  const zip = makeZip({ "[Content_Types].xml": "<Types/>", "word/document.xml": DOCUMENT, "word/styles.xml": STYLES });
  const { title, markdown } = docxToMarkdown(zip);
  expect(title).toBe("学习计划");
  expect(markdown).toBe(
    ["# 学习计划", "", "每天复习 & 总结 <30 分钟>", "", "- 第一项", "- 第二项", "", "## 细节", "", "| 科目 | 时长 |", "| --- | --- |", "| 英语 | 20 |", ""].join("\n"),
  );
});

test("不是 zip、或缺少 document.xml：extract_failed", () => {
  expect(() => docxToMarkdown(new TextEncoder().encode("hello"))).toThrow(AppError);
  expect(() => docxToMarkdown(makeZip({ "a.txt": "x" }))).toThrow(/document\.xml/);
  expect(readZipEntry(makeZip({ "a.txt": "hi" }), "a.txt")).toEqual(new TextEncoder().encode("hi"));
});
