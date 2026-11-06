import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

// 07 §1.3：HTML → linkedom 解析 → Readability 提取正文 → turndown 转 Markdown；
// 失败或正文少于 200 字时退回 body.textContent，并在 parser_version 后加 "+fallback"。

export const READABILITY_VERSION = "readability@0.6";
export const TURNDOWN_VERSION = "turndown@7";
export const MIN_ARTICLE_CHARS = 200;
const MAX_HTML_CHARS = 5_000_000;

export type Extracted = {
  title: string;
  /** 抽取出的 Markdown 正文（已规范化）。 */
  markdown: string;
  /** 抽取器版本部分；分块器版本由调用方追加（如 "+chunk1"）。 */
  parserVersion: string;
  fallback: boolean;
};

/**
 * 正文规范化：换行统一为 \n、NFC、去掉零宽/控制字符、压缩多余空行。
 * 注意是 NFC 而不是 07 原写的 NFKC：NFKC 会把全角标点（，：（）？）改成半角，
 * 破坏引用原文的保真度；NFKC 只用于分词 / 检索归一化（T-14）。
 */
export function normalizeText(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex -- 有意剔除控制字符
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function makeTurndown(): TurndownService {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
  // 表格 → Markdown 表格（turndown 默认不处理）
  td.addRule("table", {
    filter: "table",
    replacement: (_content, node) => {
      // domino 的 NodeList 不可迭代，只能按 length / 下标读取
      type Cell = { textContent: string | null };
      type Q = { querySelectorAll(s: string): { length: number; [i: number]: Q & Cell } };
      const all = (n: Q, sel: string) => {
        const l = n.querySelectorAll(sel);
        return Array.from({ length: l.length }, (_, i) => l[i]!);
      };
      const grid = all(node as unknown as Q, "tr")
        .map((tr) => all(tr, "th,td").map((c) => (c.textContent ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()))
        .filter((r) => r.some((c) => c !== "")); // 去掉全空的行（维基百科信息框的图片行等）
      if (grid.length === 0) return "";
      const width = Math.max(...grid.map((r) => r.length));
      const pad = (r: string[]) => [...r, ...Array<string>(width - r.length).fill("")];
      const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
      return `\n\n${[line(grid[0]!), line(Array<string>(width).fill("---")), ...grid.slice(1).map(line)].join("\n")}\n\n`;
    },
  });
  // 链接只留文字：URL（尤其是百科的巨长地址、锚点链接）对检索只是噪声；来源 URL 已在资料记录里
  td.addRule("link", { filter: "a", replacement: (content) => content });
  // 图片整体丢弃（alt 常常是公式源码或文件名）
  td.addRule("image", { filter: ["img", "picture"], replacement: () => "" });
  td.remove(["script", "style", "noscript", "iframe", "svg"]);
  // 这是给检索用的纯文本语料，不是要再渲染的 Markdown：不转义 [] * _ 等，否则 “[1]” 会变成 “\[1\]”
  td.escape = (s) => s;
  return td;
}

/**
 * Readability 之前的清理（针对真实页面观察到的问题）：
 * - 标题被包在 <div class="…heading…"> 里（维基百科 mw-heading 等）时，Readability 会因类名把整个标题清掉；
 *   把这种“只包一个标题的 div”展开成标题本身。
 * - 去掉“编辑”之类的段落编辑链接。
 */
type DomEl = {
  className?: string;
  querySelectorAll(s: string): Iterable<DomEl>;
  querySelector(s: string): DomEl | null;
  replaceWith(n: DomEl): void;
  remove(): void;
  children: ArrayLike<DomEl>;
};
function preclean(document: DomEl): void {
  for (const el of [...document.querySelectorAll("[class*=editsection]")]) el.remove();
  for (const wrap of [...document.querySelectorAll("div[class*=heading]")]) {
    const heading = wrap.querySelector("h1,h2,h3,h4,h5,h6");
    if (heading && wrap.children.length === 1 && wrap.children[0] === heading) wrap.replaceWith(heading);
    else if (heading && [...wrap.querySelectorAll("h1,h2,h3,h4,h5,h6")].length === 1) wrap.replaceWith(heading);
  }
}

function textFallback(doc: { body?: { textContent: string | null } | null; documentElement?: { textContent: string | null } | null }): string {
  const raw = doc.body?.textContent ?? doc.documentElement?.textContent ?? "";
  return raw.replace(/[ \t\f\v]+/g, " ").replace(/\n[ \t]+/g, "\n");
}

/** 对任何输入都不抛错：linkedom / Readability 无法处理的输入（空文档等）退回按标签剥离的纯文本。 */
export function extractHtml(html: string, pageUrl?: string): Extracted {
  const source = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  try {
    return extractHtmlInner(source, pageUrl);
  } catch {
    const stripped = source.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
    return {
      title: pageUrl ? new URL(pageUrl).hostname : "未命名",
      markdown: normalizeText(stripped.replace(/[ \t\f\v]+/g, " ")),
      parserVersion: `${READABILITY_VERSION}+${TURNDOWN_VERSION}+fallback`,
      fallback: true,
    };
  }
}

function extractHtmlInner(source: string, pageUrl?: string): Extracted {
  const { document } = parseHTML(source);
  const docTitle = (document.title ?? "").trim();
  const fallbackTitle = () => docTitle || (pageUrl ? new URL(pageUrl).hostname : "未命名");
  // 页面里只有一个 <h1> 且它出现在 <title> 里时，用它作标题（去掉 “ - 站点名” 之类的后缀）
  const h1s = [...document.querySelectorAll("h1")];
  // normalizeText 会去掉零宽字符：很多站点的标题里带着 “#” 锚点链接（里面是零宽字符）
  const h1Text = h1s.length === 1 ? normalizeText((h1s[0]!.textContent ?? "").replace(/\s+/g, " ")) : "";
  const firstTitleSegment = docTitle.split(/\s+[|\-–—_]\s+|\s*｜\s*/)[0]?.trim() ?? "";
  const pickTitle = (candidate: string | null | undefined): string => {
    const c = (candidate ?? "").trim();
    // h1 与 <title> 的第一段一致（“文章名 | 站点名”），或者 h1 出现在 <title> 且 Readability 的结果也包含它
    const useH1 = h1Text !== "" && (firstTitleSegment === h1Text || (docTitle.includes(h1Text) && c.includes(h1Text)));
    return useH1 ? h1Text : c || fallbackTitle();
  };

  let article: { title?: string | null; content?: string | null; textContent?: string | null } | null;
  try {
    // Readability 会修改传入的 document，所以在副本上做；linkedom 的 document 满足它需要的最小接口
    const { document: copy } = parseHTML(source);
    if (pageUrl) {
      const base = copy.createElement("base");
      base.setAttribute("href", pageUrl);
      copy.head?.appendChild(base);
    }
    preclean(copy as never);
    article = new Readability(copy as never, { charThreshold: 100 }).parse();
  } catch {
    article = null;
  }

  if (article?.content && (article.textContent ?? "").replace(/\s/g, "").length >= MIN_ARTICLE_CHARS) {
    const md = normalizeText(makeTurndown().turndown(article.content));
    if (md.replace(/\s/g, "").length >= MIN_ARTICLE_CHARS) {
      return { title: pickTitle(article.title), markdown: md, parserVersion: `${READABILITY_VERSION}+${TURNDOWN_VERSION}`, fallback: false };
    }
  }
  return {
    title: pickTitle(article?.title),
    markdown: normalizeText(textFallback(document as never)),
    parserVersion: `${READABILITY_VERSION}+${TURNDOWN_VERSION}+fallback`,
    fallback: true,
  };
}

/** 纯文本 / Markdown：不转换，只规范化。标题取第一个 # 标题，没有则由调用方决定。 */
export function extractPlain(text: string, kind: "text" | "markdown"): Extracted {
  let body = text.replace(/^\uFEFF/, "");
  let frontTitle: string | undefined;
  if (kind === "markdown") {
    // front matter（--- … ---）：取 title，并从正文里剥掉；只有每一行都像 “key: value” / 列表项时才认定是 front matter，
    // 避免把正文开头的分隔线误当成它
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
    const lines = m?.[1]?.split(/\r?\n/).filter((l) => l.trim() !== "") ?? [];
    if (m && lines.length > 0 && lines.every((l) => /^\s*[\w.-]+\s*:/.test(l) || /^\s*-\s/.test(l) || /^\s+\S/.test(l))) {
      frontTitle = /^title:\s*(.+?)\s*$/m.exec(m[1]!)?.[1]?.replace(/^["']|["']$/g, "").trim() || undefined;
      body = body.slice(m[0].length);
    }
  }
  const markdown = normalizeText(body);
  const h1 = kind === "markdown" ? /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(markdown)?.[1]?.trim() : undefined;
  return { title: frontTitle ?? h1 ?? "", markdown, parserVersion: kind === "markdown" ? "markdown@1" : "text@1", fallback: false };
}
