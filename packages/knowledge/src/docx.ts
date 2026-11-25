import { inflateRawSync } from "node:zlib";
import { AppError } from "@durakeep/core";

// Word（.docx）→ Markdown，不引入依赖：读 zip 中央目录 → 解压 word/document.xml 与 styles.xml →
// 按段落样式识别标题、按 numPr 识别列表、表格转成 Markdown 表格。图片、批注、页眉页脚忽略。

const MAX_ENTRY_BYTES = 30 * 1024 * 1024; // 解压后单个条目上限（防 zip 炸弹）

/** 读取 zip 中指定名字的条目（只支持 stored / deflate）；找不到返回 undefined。 */
export function readZipEntry(zip: Uint8Array, name: string): Uint8Array | undefined {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  // 从末尾找 End of Central Directory（签名 0x06054b50）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new AppError("extract_failed", "不是有效的 Word 文件");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entryName = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;
    if (size > MAX_ENTRY_BYTES) throw new AppError("too_large", "Word 文件内容过大");
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new AppError("extract_failed", "Word 文件已损坏");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compSize);
    if (method === 0) return new Uint8Array(data);
    if (method === 8) return new Uint8Array(inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }));
    throw new AppError("extract_failed", "不支持的 Word 压缩格式");
  }
  return undefined;
}

const decodeXml = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "amp") return "&";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });

/** styles.xml：样式 id → 标题级别（样式名 "heading N" / "标题 N"，或 outlineLvl）。 */
function headingStyles(xml: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!xml) return out;
  for (const m of xml.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const [, id, body] = m as unknown as [string, string, string];
    const name = /<w:name w:val="([^"]+)"/.exec(body)?.[1]?.toLowerCase() ?? "";
    const byName = /^(?:heading|标题)\s*(\d)$/.exec(name)?.[1];
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(body)?.[1];
    if (name === "title") out.set(id, 1);
    else if (byName) out.set(id, Number(byName));
    else if (outline !== undefined) out.set(id, Number(outline) + 1);
  }
  return out;
}

function paragraphText(p: string): string {
  let t = "";
  for (const m of p.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g)) {
    if (m[1] !== undefined) t += decodeXml(m[1]);
    else if (m[0] === "<w:tab/>") t += "\t";
    else t += "\n";
  }
  return t;
}

function paragraph(p: string, headings: Map<string, number>): string {
  const text = paragraphText(p).trim();
  if (text === "") return "";
  const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1];
  const level = style ? headings.get(style) ?? (/^(?:Heading|heading)(\d)$/.exec(style) ? Number(style.slice(-1)) : undefined) : undefined;
  if (level) return `${"#".repeat(Math.min(level, 6))} ${text.replace(/\n/g, " ")}`;
  const ilvl = /<w:numPr>[\s\S]*?<w:ilvl w:val="(\d)"/.exec(p)?.[1];
  if (ilvl !== undefined || /<w:numPr>/.test(p)) return `${"  ".repeat(Number(ilvl ?? 0))}- ${text}`;
  return text;
}

export function docxToMarkdown(bytes: Uint8Array): { title: string | undefined; markdown: string } {
  const doc = readZipEntry(bytes, "word/document.xml");
  if (!doc) throw new AppError("extract_failed", "不是有效的 Word 文件（缺少 document.xml）");
  const stylesBytes = readZipEntry(bytes, "word/styles.xml");
  const xml = new TextDecoder("utf-8").decode(doc);
  const headings = headingStyles(stylesBytes ? new TextDecoder("utf-8").decode(stylesBytes) : undefined);
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const out: string[] = [];
  // 顶层只有段落与表格两种块；表格内部的段落在表格分支里处理
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g)) {
    const block = m[0];
    if (block.startsWith("<w:tbl>")) {
      const rows = [...block.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((r) =>
        [...r[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((c) =>
          [...c[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((p) => paragraphText(p[0]).trim()).filter(Boolean).join(" ").replace(/\|/g, "\\|").replace(/\n/g, " "),
        ),
      );
      if (rows.length === 0) continue;
      const cols = Math.max(...rows.map((r) => r.length));
      rows.forEach((r, i) => {
        out.push("| " + [...r, ...Array(cols - r.length).fill("")].join(" | ") + " |");
        if (i === 0) out.push("|" + " --- |".repeat(cols));
      });
      out.push("");
      continue;
    }
    const line = paragraph(block, headings);
    if (line === "") continue;
    const isList = /^\s*- /.test(line);
    const prevList = out.length > 0 && /^\s*- /.test(out[out.length - 1] ?? "");
    if (!isList && prevList) out.push("");
    out.push(line);
    if (!isList) out.push("");
  }
  const markdown = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (markdown === "") throw new AppError("extract_failed", "这份 Word 文件里没有可导入的文字");
  const title = /^#{1,6}\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  return { title, markdown: markdown + "\n" };
}
