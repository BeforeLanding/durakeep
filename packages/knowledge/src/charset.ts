// 07 §1.2：字符集按 BOM → HTTP 头 → <meta charset> → UTF-8 的顺序确定，用 TextDecoder 解码（Node 带完整 ICU，支持 gbk / gb18030）。

function labelOk(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

export function charsetFromContentType(contentType: string | undefined): string | undefined {
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? "");
  return m && labelOk(m[1]!) ? m[1]!.toLowerCase() : undefined;
}

/** 在前 4096 字节（按 latin1 看待）里找 <meta charset=…> 或 <meta http-equiv content="…charset=…">。 */
export function charsetFromMeta(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  return m && labelOk(m[1]!) ? m[1]!.toLowerCase() : undefined;
}

export function detectCharset(bytes: Uint8Array, contentType: string | undefined): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return charsetFromContentType(contentType) ?? charsetFromMeta(bytes) ?? "utf-8";
}

export function decodeBody(bytes: Uint8Array, contentType: string | undefined): { text: string; charset: string } {
  const charset = detectCharset(bytes, contentType);
  return { text: new TextDecoder(charset).decode(bytes), charset }; // 默认非 fatal：坏字节变成 U+FFFD
}
