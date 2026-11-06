import { expect, test } from "vitest";
import { extractHtml, extractPlain, normalizeText } from "./extract.ts";

const para = "间隔重复是一种根据遗忘曲线安排复习时间的学习方法，它的核心思想是在即将遗忘的时刻进行复习，从而用最少的复习次数获得最长的记忆保持。";

const BLOG = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>间隔重复的科学 - 某某博客</title></head>
<body>
<header><nav><a href="/">首页</a><a href="/about">关于</a></nav></header>
<main><article>
<h1>间隔重复的科学</h1>
<h2>一、背景</h2>
<p>${para}${para}</p>
<h2>二、方法</h2>
<ul><li>第一次复习：学习后一天</li><li>第二次复习：三天后</li></ul>
<p>${para}</p>
<table><tr><th>阶段</th><th>间隔</th></tr><tr><td>第一次</td><td>1 天</td></tr><tr><td>管道|符</td><td>3 天</td></tr></table>
<pre><code>interval = interval * ease</code></pre>
<p>结论：坚持比强度更重要，“少量多次”（而不是“一次突击”）。</p>
</article></main>
<aside><h3>热门文章</h3><ul><li><a href="/a">侧栏文章A</a></li></ul></aside>
<footer>© 2026 某某博客 · 京ICP备00000000号</footer>
<script>var tracking = "SCRIPT-SHOULD-NOT-APPEAR";</script>
<style>.x{color:red}</style>
</body></html>`;

test("正文抽取：保留标题层级、列表、表格（含转义）、代码块；去掉导航、侧栏、页脚、脚本、样式", () => {
  const r = extractHtml(BLOG, "https://blog.example.com/post");
  expect(r.fallback).toBe(false);
  expect(r.parserVersion).toBe("readability@0.6+turndown@7");
  expect(r.title).toBe("间隔重复的科学"); // 去掉了 “ - 某某博客”
  const md = r.markdown;
  expect(md).toMatch(/^## 一、背景$/m);
  expect(md).toMatch(/^## 二、方法$/m);
  expect(md).toMatch(/^-\s+第一次复习：学习后一天$/m);
  expect(md).toContain("| 阶段 | 间隔 |");
  expect(md).toContain("| --- | --- |");
  expect(md).toContain("| 管道\\|符 | 3 天 |");
  expect(md).toContain("```\ninterval = interval * ease\n```");
  for (const junk of ["首页", "热门文章", "侧栏文章A", "京ICP备", "SCRIPT-SHOULD-NOT-APPEAR", "color:red"]) expect(md, junk).not.toContain(junk);
});

test("全角标点原样保留（不做 NFKC 折叠）：，。：（）？“” 不会变成半角", () => {
  const md = extractHtml(BLOG).markdown;
  expect(md).toContain("，");
  expect(md).toContain("（而不是“一次突击”）");
  expect(md).not.toMatch(/少量多次"\(/);
  expect(normalizeText("ＡＢＣ，（１）：")).toBe("ＡＢＣ，（１）："); // 只做 NFC
});

test("normalizeText：统一换行、NFC 组合字符、去零宽与控制字符、压缩空行与行尾空白", () => {
  expect(normalizeText("a\r\nb\rc")).toBe("a\nb\nc");
  expect(normalizeText("é")).toBe("é"); // NFC
  expect(normalizeText("零​宽﻿字\u0007符")).toBe("零宽字符");
  expect(normalizeText("a   \n\n\n\n\nb\t\n")).toBe("a\n\nb");
  expect(normalizeText("  \n  x  \n  ")).toBe("x");
});

test("正文过短或不是文章：退回 body.textContent，parser_version 带 +fallback；标题取 <title>", () => {
  const r = extractHtml("<html><head><title>短页面</title></head><body><p>只有一句话。</p><script>x=1</script></body></html>");
  expect(r.fallback).toBe(true);
  expect(r.parserVersion).toBe("readability@0.6+turndown@7+fallback");
  expect(r.title).toBe("短页面");
  expect(r.markdown).toContain("只有一句话。");
  const noTitle = extractHtml("<html><body><p>无标题</p></body></html>", "https://example.com/p");
  expect(noTitle.title).toBe("example.com"); // 没有任何标题时用主机名
});

test("畸形 HTML、空文档、超大文档都不抛错", () => {
  expect(() => extractHtml("<div><p>未闭合 <b>标签")).not.toThrow();
  expect(extractHtml("").markdown).toBe("");
  const huge = "<p>" + "字".repeat(6_000_000) + "</p>";
  const r = extractHtml(huge);
  expect(r.markdown.length).toBeLessThanOrEqual(5_000_000);
});

test("纯文本 / Markdown：只规范化；Markdown 取第一个标题作为标题", () => {
  const md = extractPlain("﻿# 会议记录\r\n\r\n- 议题一\r\n- 议题二\r\n\r\n\r\n\r\n结论。", "markdown");
  expect(md.markdown).toBe("# 会议记录\n\n- 议题一\n- 议题二\n\n结论。");
  expect(md.title).toBe("会议记录");
  expect(md.parserVersion).toBe("markdown@1");
  const txt = extractPlain("# 这不是标题，只是文本\n正文", "text");
  expect(txt.title).toBe("");
  expect(txt.parserVersion).toBe("text@1");
  expect(extractPlain("没有标题的 Markdown", "markdown").title).toBe("");
});

// ---- 以下用例固定住“真实页面检查”里发现的问题（T-13 抽取质量检查，见 docs/spikes/T13-extraction-check.md）----

const ZW = String.fromCharCode(0x200b);
const longPara = para + para;

test("标题被包在 div.mw-heading 里（维基百科）：小标题保留，编辑链接去掉", () => {
  const html = `<html><head><title>遗忘曲线 - 维基百科</title></head><body><div id="content"><h1>遗忘曲线</h1>
  <p>${longPara}</p>
  <div class="mw-heading mw-heading2"><h2 id="a">理论基础</h2><span class="mw-editsection">[<a href="/edit">编辑</a>]</span></div>
  <p>${longPara}</p>
  <div class="mw-heading mw-heading2"><h2 id="b">结果</h2><span class="mw-editsection">[<a href="/edit">编辑</a>]</span></div>
  <p>${longPara}</p></div></body></html>`;
  const md = extractHtml(html, "https://zh.wikipedia.org/wiki/x").markdown;
  expect(md).toMatch(/^## 理论基础$/m);
  expect(md).toMatch(/^## 结果$/m);
  expect(md).not.toContain("编辑");
});

test("链接只留文字、图片丢弃、不转义方括号（检索语料不要 URL，也不要把 [1] 变成带反斜杠的形式）", () => {
  const html = `<html><head><title>T</title></head><body><article><h1>T</h1>
  <p>${longPara}见<a href="https://example.com/a?x=1">这个链接</a>以及引用<sup>[1]</sup>，和 a_b*c 这样的文字。</p>
  <p><img src="https://example.com/m.svg" alt="{displaystyle R=e^{-t/S}}">公式如上。${longPara}</p></article></body></html>`;
  const md = extractHtml(html).markdown;
  expect(md).toContain("见这个链接以及引用[1]");
  expect(md).toContain("a_b*c");
  expect(md).not.toContain("example.com");
  expect(md).not.toContain("displaystyle");
  expect(md).not.toContain("](");
});

test("<h1> 里带零宽字符的锚点（Vue 文档站）：标题取 h1，而不是 Readability 选中的站点名", () => {
  const html = `<html><head><title>简介 | Vue.js</title></head><body><main><article>
  <h1 id="i">简介 <a class="header-anchor" href="#i">${ZW}</a></h1><p>${longPara}</p><p>${longPara}</p></article></main></body></html>`;
  expect(extractHtml(html, "https://cn.vuejs.org/guide/introduction").title).toBe("简介");
});

test("表格：全空的行（信息框的图片行）被去掉，不会出现空表头", () => {
  const html = `<html><head><title>T</title></head><body><article><h1>T</h1><p>${longPara}</p>
  <table><tr><td></td><td></td></tr><tr><td>开发者</td><td>D. Richard Hipp</td></tr><tr><td>首次发布</td><td>2000 年</td></tr></table><p>${longPara}</p></article></body></html>`;
  const md = extractHtml(html).markdown;
  expect(md).toContain("| 开发者 | D. Richard Hipp |");
  expect(md).not.toMatch(/\|\s+\|\s+\|\n\| --- /); // 表头不是空行
});

test("Markdown 的 front matter：取 title 并从正文剥掉；正文开头的分隔线不会被误认为 front matter", () => {
  const withFm = extractPlain("---\ntitle: 快速入门\ntranslators:\n - x-cold\n - sooia\n---\n\n## 创建组件\n正文。", "markdown");
  expect(withFm.title).toBe("快速入门");
  expect(withFm.markdown).toBe("## 创建组件\n正文。");
  expect(extractPlain('---\ntitle: "带引号的标题"\n---\n正文', "markdown").title).toBe("带引号的标题");
  const hr = extractPlain("---\n这是正文的第一行\n---\n后面还有内容", "markdown");
  expect(hr.title).toBe("");
  expect(hr.markdown).toContain("这是正文的第一行");
  // text 类型不做 front matter 处理
  expect(extractPlain("---\ntitle: x\n---\n正文", "text").markdown).toContain("title: x");
});
