// T-13 DoD：对真实中文页面做一次抽取质量检查。会联网（每个页面 1 次 GET + 每个站点 1 次 robots.txt）。
// 用法：node scripts/extract-quality-check.ts [urls.txt]
// 只在控制台输出指标和标题大纲，不保存网页原文。页面内容会变化，所以这是“当时的快照结论”，不是回归测试。
import { readFileSync } from "node:fs";
import { decodeBody } from "../packages/knowledge/src/charset.ts";
import { extractHtml, extractPlain } from "../packages/knowledge/src/extract.ts";
import { assertRobotsAllows, safeFetch } from "../packages/knowledge/src/fetch.ts";
import { normalizeUrl } from "../packages/knowledge/src/url.ts";

const DEFAULT_URLS = [
  "https://zh.wikipedia.org/wiki/遗忘曲线",
  "https://zh.wikipedia.org/wiki/SQLite",
  "https://zh.wikipedia.org/wiki/Node.js",
  "https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Overview",
  "https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Guide/Introduction",
  "https://cn.vuejs.org/guide/introduction.html",
  "https://zh-hans.react.dev/learn",
  "https://www.ruanyifeng.com/blog/2011/09/restful.html",
  "https://www.ruanyifeng.com/blog/2019/09/curl-reference.html",
  "https://www.liaoxuefeng.com/wiki/1016959663602400",
];
const urls = process.argv[2] ? readFileSync(process.argv[2], "utf8").split(/\r?\n/).filter(Boolean) : DEFAULT_URLS;

// 常见的“非正文”词，出现在抽取结果里说明导航 / 页脚 / 推荐混进来了
const NOISE = ["上一篇", "下一篇", "相关文章", "推荐阅读", "版权所有", "Copyright", "备案", "登录", "注册", "分享到", "评论", "目录", "导航", "Skip to"];

for (const raw of urls) {
  const url = normalizeUrl(raw);
  const row: Record<string, unknown> = { url };
  try {
    await assertRobotsAllows(url);
    const t0 = Date.now();
    const res = await safeFetch(url);
    const media = res.contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
    const { text, charset } = decodeBody(res.bytes, res.contentType);
    const ex = media === "text/markdown" ? extractPlain(text, "markdown") : media === "text/plain" ? extractPlain(text, "text") : extractHtml(text, res.finalUrl);
    const md = ex.markdown;
    const lines = md.split("\n");
    const headings = lines.filter((l) => /^#{1,6}\s/.test(l));
    row.status = res.status;
    row.finalUrl = res.finalUrl === url ? "(同)" : res.finalUrl;
    row.ms = Date.now() - t0;
    row.rawBytes = res.bytes.length;
    row.charset = charset;
    row.parser = ex.parserVersion;
    row.title = ex.title;
    row.chars = Array.from(md).length;
    row.cjkRatio = Number((((md.match(/[一-鿿]/g) ?? []).length) / Math.max(1, md.length)).toFixed(2));
    row.headings = headings.length;
    row.outline = headings.slice(0, 8).map((h) => h.slice(0, 40));
    row.tables = lines.filter((l) => /^\|\s*---/.test(l)).length;
    row.codeFences = Math.floor((md.match(/```/g) ?? []).length / 2); // 围栏可能在引用块或列表里，不一定在行首
    row.listItems = lines.filter((l) => /^\s*[-*]\s|^\s*\d+\.\s/.test(l)).length;
    row.links = (md.match(/\]\(/g) ?? []).length;
    row.noise = NOISE.filter((w) => md.includes(w));
    row.replacementChars = (md.match(/�/g) ?? []).length;
    row.head = md.slice(0, 80).replace(/\n/g, "⏎");
    row.tail = md.slice(-80).replace(/\n/g, "⏎");
  } catch (e) {
    row.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    const code = (e as { code?: string }).code;
    if (code) row.code = code;
  }
  console.log(JSON.stringify(row));
  await new Promise((r) => setTimeout(r, 1000));
}
