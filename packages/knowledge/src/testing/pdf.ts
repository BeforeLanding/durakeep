// 测试用的最小 PDF 生成器：每页若干行文字（可指定字号）。中文用不嵌入字体的 STSong-Light + UniGB-UCS2-H 编码，
// 这正是需要 CJK CMap 才能正确抽取的情形。只用于测试，不追求通用。

export type PdfLine = { text: string; size?: number };

const hexUcs2 = (s: string) =>
  "<" + Array.from(s).map((ch) => ch.codePointAt(0)!.toString(16).padStart(4, "0")).join("").toUpperCase() + ">";

export function makePdf(pages: PdfLine[][]): Uint8Array {
  const objs: string[] = [];
  const add = (body: string) => {
    objs.push(body);
    return objs.length; // 对象号从 1 开始
  };
  const catalog = add(""); // 占位，最后回填
  const pagesObj = add("");
  const descriptor = add("<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>");
  const cidFont = add(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor ${descriptor} 0 R /DW 1000 >>`);
  const font = add(`<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${cidFont} 0 R] >>`);
  const kids: number[] = [];
  for (const lines of pages) {
    let y = 780;
    const ops = lines.map((l) => {
      const size = l.size ?? 12;
      y -= size * 1.8;
      return `BT /F1 ${size} Tf 72 ${y} Td ${hexUcs2(l.text)} Tj ET`;
    }).join("\n");
    const content = add(`<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}
