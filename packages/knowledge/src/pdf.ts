import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { AppError } from "@durakeep/core";

// PDF → Markdown（只抽文字层，不渲染、不 OCR）。用 Mozilla PDF.js（pdfjs-dist）的 legacy 构建：
// - CJK 必须提供 CMap（cMapUrl 在 Node 下要传文件系统路径，不是 file:// URL），否则不嵌入字体的中文会抽成空串；
// - 关闭 eval 与字体加载，只读文本内容；
// - 按字号识别标题（明显大于正文的短行），按行距与标点把同一段的折行拼回去。

export const MAX_PDF_PAGES = 1000;

type TextItem = { str: string; height: number; hasEOL: boolean; transform: number[] };
type PdfJs = {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDoc>; destroy(): Promise<void> };
};
type PdfDoc = {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }>; cleanup(): void }>;
  getMetadata(): Promise<{ info?: Record<string, unknown> }>;
};

let loaded: Promise<{ pdfjs: PdfJs; root: string }> | undefined;

/** 懒加载 PDF.js；加载时它会抱怨缺少画布库（我们不渲染，不需要），这几行警告不进日志。 */
function load() {
  loaded ??= (async () => {
    const req = createRequire(import.meta.url);
    const root = dirname(req.resolve("pdfjs-dist/package.json"));
    const warn = console.warn;
    const log = console.log;
    const quiet = (orig: (...a: unknown[]) => void) => (...a: unknown[]) => {
      if (typeof a[0] === "string" && /^Warning: Cannot (load "@napi-rs\/canvas"|polyfill)/.test(a[0])) return;
      orig(...a);
    };
    console.warn = quiet(warn);
    console.log = quiet(log);
    try {
      const pdfjs = (await import(pathToFileURL(join(root, "legacy/build/pdf.mjs")).href)) as PdfJs;
      return { pdfjs, root };
    } finally {
      console.warn = warn;
      console.log = log;
    }
  })();
  return loaded;
}

type Line = { text: string; size: number; page: number };

const TERMINAL = /[。！？!?.:：；;」』”"）)]$/;
const LIST = /^\s*(?:[-*•·●○▪]|\d+[.)、]|[（(]\d+[)）]|[一二三四五六七八九十]+、)\s*/;
const PAGE_NO = /^(?:[-–—]?\s*\d+\s*[-–—]?|第\s*\d+\s*页(?:\s*[,，/／]?\s*共\s*\d+\s*页)?|\d+\s*[/／]\s*\d+|page\s+\d+(?:\s+of\s+\d+)?)$/i;
const isCjk = (ch: string | undefined) => !!ch && /[\u3000-\u9fff\uff00-\uffef]/.test(ch);

function pageLines(items: unknown[], page: number): Line[] {
  const lines: Line[] = [];
  let cur = "";
  let size = 0;
  let lastY: number | undefined;
  const flush = () => {
    const t = cur.replace(/\s+/g, " ").trim();
    if (t !== "") lines.push({ text: t, size, page });
    cur = "";
    size = 0;
  };
  for (const raw of items) {
    if (!raw || typeof raw !== "object" || !("str" in raw)) continue;
    const it = raw as TextItem;
    const y = it.transform?.[5];
    if (cur !== "" && lastY !== undefined && y !== undefined && Math.abs(y - lastY) > Math.max(2, (it.height || size || 10) * 0.5)) flush();
    cur += it.str;
    if (it.str.trim() !== "" && it.height > size) size = it.height;
    if (y !== undefined && it.str !== "") lastY = y;
    if (it.hasEOL) flush();
  }
  flush();
  return lines;
}

/** 把行拼成 Markdown：字号明显大的短行作标题（最多三级），正文折行按标点拼成段落，去掉页码行与每页重复的页眉页脚。 */
export function linesToMarkdown(all: Line[], pages: number): string {
  // 每页都出现（≥3 页且出现在 ≥60% 的页上）的短行视为页眉 / 页脚
  const perPage = new Map<string, Set<number>>();
  for (const l of all) if (Array.from(l.text).length <= 40) (perPage.get(l.text) ?? perPage.set(l.text, new Set()).get(l.text)!).add(l.page);
  const repeated = new Set([...perPage].filter(([, ps]) => pages >= 3 && ps.size >= Math.ceil(pages * 0.6)).map(([t]) => t));
  const lines = all.filter((l) => !PAGE_NO.test(l.text) && !repeated.has(l.text));
  if (lines.length === 0) return "";

  // 正文字号：按字符数加权的众数
  const weight = new Map<number, number>();
  for (const l of lines) {
    const k = Math.round(l.size * 2) / 2;
    weight.set(k, (weight.get(k) ?? 0) + Array.from(l.text).length);
  }
  const body = [...weight].sort((a, b) => b[1] - a[1])[0]![0] || 10;
  const isHeading = (l: Line) => l.size >= body * 1.2 && Array.from(l.text).length <= 60 && !/[。，,；;]$/.test(l.text);
  const headingSizes = [...new Set(lines.filter(isHeading).map((l) => Math.round(l.size)))].sort((a, b) => b - a);
  const levelOf = (l: Line) => Math.min(headingSizes.indexOf(Math.round(l.size)) + 1, 3);

  const out: string[] = [];
  let para = "";
  const end = () => {
    if (para !== "") out.push(para, "");
    para = "";
  };
  for (const l of lines) {
    if (isHeading(l)) {
      end();
      out.push(`${"#".repeat(levelOf(l))} ${l.text}`, "");
      continue;
    }
    if (LIST.test(l.text)) {
      end();
      para = "- " + l.text.replace(LIST, "");
      if (Array.from(l.text).length < 30) end(); // 短的列表行就是完整的一项；长的才可能折到下一行
      continue;
    }
    if (para === "") para = l.text;
    else if (isCjk(Array.from(para).pop()) || isCjk(l.text[0])) para += l.text;
    else para += " " + l.text;
    if (TERMINAL.test(l.text) && Array.from(l.text).length < 30) end(); // 短句以句号结尾，多半是段落末行
  }
  end();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

const titleFromInfo = (info: Record<string, unknown> | undefined) => {
  const t = typeof info?.Title === "string" ? info.Title.trim() : "";
  if (!t || /^(untitled|无标题|microsoft word - )/i.test(t) || /\.(docx?|pdf|pptx?)$/i.test(t)) return undefined;
  return t;
};

export async function pdfToMarkdown(bytes: Uint8Array): Promise<{ title: string | undefined; markdown: string; pages: number }> {
  if (!new TextDecoder("latin1").decode(bytes.subarray(0, 1024)).includes("%PDF-")) {
    throw new AppError("extract_failed", "不是有效的 PDF 文件");
  }
  const { pdfjs, root } = await load();
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes), // 复制：PDF.js 会转移这块内存；Buffer.slice() 只是视图，会把共享的内存池一起转走
    cMapUrl: join(root, "cmaps") + "/",
    cMapPacked: true,
    standardFontDataUrl: join(root, "standard_fonts") + "/",
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    return await readAll(task);
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("extract_failed", "无法解析这份 PDF"); // PDF.js 的其他异常一律视为内容问题，不重试
  } finally {
    await task.destroy().catch(() => {});
  }
}

async function readAll(task: { promise: Promise<PdfDoc> }): Promise<{ title: string | undefined; markdown: string; pages: number }> {
  {
    let doc: PdfDoc;
    try {
      doc = await task.promise;
    } catch (e) {
      const name = (e as Error).name;
      if (name === "PasswordException") throw new AppError("extract_failed", "这份 PDF 有密码保护，请先解除密码再上传");
      throw new AppError("extract_failed", "不是有效的 PDF 文件，或文件已损坏");
    }
    if (doc.numPages > MAX_PDF_PAGES) throw new AppError("too_large", `PDF 超过 ${MAX_PDF_PAGES} 页`);
    const lines: Line[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      lines.push(...pageLines((await page.getTextContent()).items, i));
      page.cleanup();
    }
    const markdown = linesToMarkdown(lines, doc.numPages);
    if (markdown.replace(/^#.*$/gm, "").trim() === "") {
      throw new AppError("extract_failed", "这份 PDF 没有可提取的文字（可能是扫描件或纯图片），目前不支持 OCR");
    }
    const info = await doc.getMetadata().then((m) => m.info, () => undefined);
    const title = titleFromInfo(info) ?? /^#{1,3}\s+(.+)$/m.exec(markdown)?.[1]?.trim();
    return { title, markdown, pages: doc.numPages };
  }
}
